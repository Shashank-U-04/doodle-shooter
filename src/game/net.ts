// Online play — peer-to-peer free-for-all over WebRTC data channels.
//
// The transport is PeerJS: the public broker only introduces the browsers to
// each other and is never asked to run the game. After that first handshake
// every packet travels straight from player to player, which is what keeps a
// match playable without a game server.
//
// Topology is a star through the host: guests dial the host, and the host
// relays. That means one code to share, one connection per guest, and a single
// place where the roster lives.
//
// Authority is deliberately split the way a casual shooter does it: every
// player is authoritative over their own body (position, health, whether they
// are down), while the shooter is the one who decides their bullet connected.
// A hit is therefore reported by the client that fired it and applied by the
// client that took it — the only client whose opinion about its own health
// counts.

import Peer, { type DataConnection } from "peerjs";
// The transform gate lives beside the state it guards, in types.ts, so the
// transport and any test ask the same question about a stale packet.
import { shouldApplyState, type NetPlayerState, type NetShotOrigin } from "./types";
import { normalizeMatchConfig, type MatchConfig } from "./maps";
import { drawRoomCode } from "./room";
import { MAX_PLAYERS } from "../../server/src/shared/rules.js";
import {
  brokerConfigProblem,
  classifySignalError,
  describeBroker,
  exhaustedSignalText,
  MAX_SIGNAL_ATTEMPTS,
  nextSignalBackoff,
  readBrokerConfig,
  SIGNAL_OPEN_TIMEOUT_MS,
  type BrokerConfig,
  type SignalFailure,
} from "./signaling";

/**
 * The signaling socket, as the lobby should describe it.
 *
 *   connecting — first attempt, no answer yet
 *   open       — the broker accepted this peer id
 *   retrying   — the socket dropped; a bounded retry is scheduled
 *   lost       — every bounded retry failed; the room is no longer discoverable
 *   closed     — the page left deliberately
 */
export type SignalState = "idle" | "connecting" | "open" | "retrying" | "lost" | "closed";

/** One player as the lobby and the scoreboard see them. */
export type NetPlayer = {
  id: string;
  name: string;
  /** ink palette index, so every player reads as a different doodle */
  ink: number;
  isMe: boolean;
  isHost: boolean;
  kills: number;
  deaths: number;
  state: NetPlayerState;
  /** false once their state stops arriving (closed tab, lost connection, …) */
  online: boolean;
  /** lobby ready state; the host is always ready */
  ready: boolean;
};

type RosterEntry = { id: string; name: string; ink: number; ready: boolean };

type NetMsg =
  | { t: "hello"; name: string }
  | { t: "full" }
  | { t: "roster"; list: RosterEntry[] }
  /** guest → host: one body */
  | { t: "state"; s: NetPlayerState }
  /** host → guest: every body, in one ordered packet (see tick()) */
  | { t: "states"; list: { id: string; s: NetPlayerState }[] }
  | { t: "hit"; victim: string; dmg: number; epoch: number; origin: NetShotOrigin }
  | { t: "death"; killer: string }
  | { t: "respawn"; epoch: number }
  /** host → room: the authoritative map + grapple rule */
  | { t: "config"; config: MatchConfig }
  /** guest → host: lobby ready flag */
  | { t: "ready"; ready: boolean }
  /** host → room: begin, carrying the rules the match is actually built with */
  | { t: "start"; config?: MatchConfig }
  | { t: "rematch" }
  | { t: "ping"; t0: number }
  | { t: "pong"; t0: number }
  | { t: "bye" };

type Envelope = NetMsg & { from: string; name?: string; ink?: number };

export type NetHandlers = {
  /** a remote player's transform arrived — hand it straight to the engine */
  onRemoteState?: (id: string, state: NetPlayerState) => void;
  /**
   * Someone's shot landed on us. `epoch` is the generation of our body the
   * shooter aimed at (so a hit that predates our respawn can be dropped) and
   * `origin` is where the shot came from (so its path can be checked).
   */
  onHitMe?: (dmg: number, killerId: string, epoch: number, origin: NetShotOrigin) => void;
  onDeath?: (victimId: string, killerId: string) => void;
  onRespawn?: (id: string, epoch: number) => void;
  /** the host restarted the match: clear the scoreboard and drop the overlay */
  onRematch?: () => void;
  /** our measured half round trip changed — feed it to the engine's aim model */
  onLatency?: (ms: number) => void;
  /** the host said go; adopt `config` if it is present (it is authoritative) */
  onStart?: (config?: MatchConfig) => void;
  /** the host's match rules changed, or arrived for the first time */
  onConfig?: (config: MatchConfig) => void;
  onFeed?: (text: string, hot: boolean) => void;
  onStatus?: (text: string) => void;
  /** signaling broker state changed — separate from ICE/TURN and from errors */
  onSignal?: (state: SignalState, detail?: string) => void;
  onError?: (text: string) => void;
  /** the roster or a score changed — re-render */
  onChange?: () => void;
  /** a peer left (cleanly, or by going silent) — drop whatever we cached for them */
  onPeerGone?: (id: string) => void;
};

const PREFIX = "ds-pvp-";

/** The signaling broker, read once at module load (never a secret). */
const BROKER: BrokerConfig = readBrokerConfig(import.meta.env as Record<string, unknown>);

/**
 * How long a peer may go quiet before we treat it as gone (ms).
 *
 * Generous on purpose: the host relays three other players' transforms, so a
 * guest on a mobile link can lose a couple of seconds to a stall and still be
 * in the match. Six seconds used to be "gone" and that is a drop, not a
 * disconnect — the player never left, the phone just hiccuped.
 */
const SILENCE_MS = 12000;

/** Hard ceiling on the lobby (shared with the match server). The star topology does not scale past this either. */
export { MAX_PLAYERS };

/**
 * How long one dial attempt gets before it is declared dead (ms).
 *
 * A direct ICE handshake on a workable route completes in one to three
 * seconds. Eight seconds is well past that, and leaves room for a second
 * attempt inside the twenty seconds a player will actually wait.
 */
const DIAL_TIMEOUT_MS = 8000;
/** Fresh peer connections a guest may open before it reports the failure. */
const MAX_DIALS = 2;
/** Beat between the two attempts, so the broker has dropped the dead channel. */
const RETRY_DELAY_MS = 700;
/**
 * Bounded re-dials after an established data channel closes in the lobby.
 * A host that merely restarted should be back within a few seconds; a host
 * that left must not be dialled forever.
 */
const MAX_REJOINS = 2;
/** How long a relay-credential fetch may take before it is skipped. */
const TURN_FETCH_TIMEOUT_MS = 4000;
/** Refresh a credential this long before it actually expires. */
const TURN_REFRESH_SKEW_MS = 120_000;

/**
 * The ICE server list, resolved once per page.
 *
 * PeerJS ships a default list, but it is shared by every PeerJS app in the
 * world and reachable on one UDP port — which is exactly what a strict carrier
 * NAT or a locked-down office firewall drops. A `config` passed to `new Peer`
 * *replaces* that default wholesale (PeerJS shallow-merges its options, it does
 * not merge `config`), so this builds the entire list: public STUN for the easy
 * cases, then whichever TURN relay the deployment configured for the hard ones.
 *
 * Preference order:
 *   1. This deployment's own credential endpoint, `<VITE_CONVEX_SITE_URL>/turn`
 *      (src/convex/turn.ts). Best, because the relay secret never reaches the
 *      browser, the credential expires, and no redeploy is needed to rotate.
 *   2. `VITE_TURN_CREDENTIALS_URL` — a third-party credential endpoint
 *      (Metered Open Relay, Cloudflare Realtime TURN, …). Explicit opt-in.
 *   4. `VITE_TURN_URLS` + `VITE_TURN_USERNAME` + `VITE_TURN_CREDENTIAL` — a
 *      static relay, for providers that hand out long-lived credentials.
 *   5. STUN only. Fine on a home network, cannot cross a symmetric NAT, so a
 *      cellular-to-cellular match will not connect without a relay.
 *
 * Relays are the only way a match between two restricted networks works; when
 * none is available this records *why* (see `IcePlan.note`) instead of leaving
 * the player with a generic timeout.
 */
const STUN_ONLY: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

/** Verbose ICE logging is a development tool, not a production console flood. */
const NET_DEBUG = Boolean(import.meta.env.VITE_NET_DEBUG) || Boolean(import.meta.env.DEV);
function netLog(...args: unknown[]) {
  if (NET_DEBUG) console.info(...args);
}

/** Why a plan has no relay (or why its credentials may be stale). */
export type IcePlanIssue =
  | "none"
  | "unconfigured"
  | "no-endpoint"
  | "endpoint-unreachable"
  | "endpoint-rejected"
  | "endpoint-empty"
  | "static-invalid";

export type IcePlan = {
  servers: RTCIceServer[];
  /** where the relay (if any) came from */
  relay: "none" | "static" | "endpoint" | "deployment";
  /** log-safe explanation when there is no relay, or the endpoint failed */
  note?: string;
  /** machine-readable reason, so the lobby can stop blaming TURN_URLS for a CORS failure */
  issue?: IcePlanIssue;
  /** ms epoch at which minted credentials expire (server endpoint only) */
  expiresAt?: number;
  /** which variable/endpoint supplied the relay — log-safe */
  source?: string;
};

/** What kind of ICE candidate a connection actually managed to gather. */
export type CandidateTally = { host: number; srflx: number; relay: number; prflx: number; total: number };

export const emptyTally = (): CandidateTally => ({ host: 0, srflx: 0, relay: 0, prflx: 0, total: 0 });

const isRelayUrl = (u: string) => /^turns?:/i.test(u);
const isIceUrl = (u: string) => /^(stuns?|turns?):/i.test(u);

/**
 * Drop everything the browser cannot use before it reaches RTCPeerConnection.
 *
 * A relay entry with no username/credential can only ever answer 401, and a
 * `http://` or `stun:` URL in a relay slot quietly consumes the whole ICE
 * allowance while gathering nothing. Both are rejected here, and the count is
 * kept so the diagnostics can say the configuration itself was broken rather
 * than blaming the network.
 */
export function sanitizeIceServers(input: unknown): { servers: RTCIceServer[]; relay: number; dropped: number } {
  const servers: RTCIceServer[] = [];
  let relay = 0;
  let dropped = 0;
  const list = Array.isArray(input) ? input : [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      dropped++;
      continue;
    }
    const e = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const raw = Array.isArray(e.urls) ? e.urls : typeof e.urls === "string" ? [e.urls] : [];
    const urls = raw.map((u) => String(u).trim()).filter((u) => isIceUrl(u));
    if (urls.length === 0) {
      dropped++;
      continue;
    }
    if (!urls.some(isRelayUrl)) {
      servers.push({ urls });
      continue;
    }
    const username = typeof e.username === "string" ? e.username : "";
    const credential = typeof e.credential === "string" ? e.credential : "";
    if (!username || !credential) {
      dropped++;
      continue;
    }
    servers.push({ urls, username, credential });
    relay++;
  }
  return { servers, relay, dropped };
}

let icePlan: Promise<IcePlan> | null = null;
let icePlanExpiresAt = 0;
/** Non-expiring STUN-only plans are still re-checked this often. */
const ICE_PLAN_IDLE_TTL_MS = 5 * 60 * 1000;

/** Drop the cached plan so the next resolve asks the credential endpoint again. */
export function clearIcePlanCache(): void {
  icePlan = null;
  icePlanExpiresAt = 0;
}

/**
 * Resolve the complete ICE list, with a lifetime.
 *
 * Order matters: the deployment's own credential endpoint first (nothing
 * secret ships in the bundle and the relay can rotate without a redeploy),
 * then an explicitly configured third-party endpoint, then a static relay.
 * Whatever the outcome, the reason is recorded rather than swallowed.
 *
 * The plan is cached until its credentials are about to expire, not forever.
 * A tab that sits in a lobby for more than an hour used to keep minted TURN
 * credentials that had already timed out, so the first guest to need a relay
 * gathered none and the lobby blamed the player's network.
 */
export function resolveIcePlan(force = false): Promise<IcePlan> {
  const now = Date.now();
  if (!force && icePlan && now < icePlanExpiresAt) return icePlan;
  clearIcePlanCache();
  const pending = buildIcePlan(now);
  icePlan = pending;
  void pending.then((plan) => {
    if (icePlan !== pending) return; // a forced refresh superseded this one
    const until = plan.expiresAt ? plan.expiresAt - TURN_REFRESH_SKEW_MS : now + ICE_PLAN_IDLE_TTL_MS;
    icePlanExpiresAt = Math.max(now + 5_000, until);
  });
  return pending;
}

/** fetch() with a deadline: a hanging credential endpoint must not stall signaling. */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { cache: "no-store", signal: ctl.signal, mode: "cors" });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the `.convex.site` origin, validating rather than trusting a typo. */
function convexSiteUrl(env: Record<string, unknown>): string | null {
  const explicit = String(env.VITE_CONVEX_SITE_URL ?? "").trim();
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit.replace(/\/+$/, "") : null;
  const convexUrl = String(env.VITE_CONVEX_URL ?? "").trim();
  if (!convexUrl) return null;
  // Both the production (`https://name.convex.cloud`) and preview shapes.
  const derived = convexUrl.replace(/\/+$/, "").replace(/\.convex\.cloud$/, ".convex.site");
  return /^https?:\/\//i.test(derived) && /\.convex\.site$/.test(derived) ? derived : null;
}

async function buildIcePlan(now: number): Promise<IcePlan> {
  const env = import.meta.env as Record<string, unknown>;
  const explicit = String(env.VITE_TURN_CREDENTIALS_URL ?? "").trim();
  const site = convexSiteUrl(env);

  const endpoints: { url: string; relay: IcePlan["relay"]; source: string }[] = [];
  if (explicit) endpoints.push({ url: explicit, relay: "endpoint", source: "VITE_TURN_CREDENTIALS_URL" });
  if (site) endpoints.push({ url: `${site}/turn`, relay: "deployment", source: "<deployment>.convex.site/turn" });

  let note = "";
  let issue: IcePlanIssue = "unconfigured";
  if (endpoints.length === 0) {
    note = "VITE_CONVEX_SITE_URL / VITE_CONVEX_URL is not set, so the deployment's /turn endpoint was never asked";
    issue = "no-endpoint";
  }
  for (const endpoint of endpoints) {
    try {
      const res = await fetchWithTimeout(endpoint.url, TURN_FETCH_TIMEOUT_MS);
      if (!res.ok) {
        note = `the relay credential service answered HTTP ${res.status}`;
        issue = "endpoint-rejected";
        continue;
      }
      const body = (await res.json()) as
        | RTCIceServer[]
        | { iceServers?: RTCIceServer[]; configured?: boolean; reason?: string; expiresAt?: number; ttl?: number };
      const raw = Array.isArray(body) ? body : (body.iceServers ?? []);
      const clean = sanitizeIceServers(raw);
      if (clean.relay > 0) {
        const expiresAt = !Array.isArray(body) && Number.isFinite(body.expiresAt) ? Number(body.expiresAt) * 1000 : undefined;
        const ttl = !Array.isArray(body) && Number.isFinite(body.ttl) ? Number(body.ttl) : 0;
        return {
          servers: [...STUN_ONLY, ...clean.servers],
          relay: endpoint.relay,
          source: endpoint.source,
          expiresAt: expiresAt && expiresAt > now ? expiresAt : ttl > 0 ? now + ttl * 1000 : undefined,
        };
      }
      const reason = !Array.isArray(body) && typeof body.reason === "string" ? body.reason : "";
      note = reason || "the relay credential service returned no usable TURN server";
      // "configured:false" is the deployment saying TURN_URLS/SECRET are absent;
      // an otherwise-empty 200 means the config is broken in another way.
      issue = !Array.isArray(body) && body.configured === false ? "unconfigured" : "endpoint-empty";
      if (clean.dropped > 0) note += ` (${clean.dropped} rejected)`;
    } catch (err) {
      const e = err as Error;
      const timedOut = e?.name === "AbortError";
      note = timedOut
        ? `the relay credential service did not answer within ${Math.round(TURN_FETCH_TIMEOUT_MS / 1000)}s`
        : `the relay credential service could not be reached (${e?.message ?? String(err)})`;
      // A CORS rejection and an offline endpoint both surface as a TypeError;
      // either way this is a deployment/reachability problem, not "TURN is off".
      issue = "endpoint-unreachable";
    }
  }

  const urls = String(env.VITE_TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const username = env.VITE_TURN_USERNAME as string | undefined;
  const credential = env.VITE_TURN_CREDENTIAL as string | undefined;
  if (urls.length > 0) {
    const clean = sanitizeIceServers([{ urls, username, credential }]);
    if (clean.relay > 0) return { servers: [...STUN_ONLY, ...clean.servers], relay: "static", source: "VITE_TURN_URLS" };
    note = "VITE_TURN_URLS is not a turn:/turns: URL, or VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL is missing";
    issue = "static-invalid";
  }

  // Always a warning, never gated by NET_DEBUG: this is the one line that
  // explains most "it finds the room but never connects" reports.
  console.warn(`[net] No TURN relay available — ${note || "no relay is configured"} (${issue}).`);
  return { servers: STUN_ONLY, relay: "none", note: note || "no relay is configured", issue };
}

/** Compatibility shim: the ICE list alone, for anything that just wants servers. */
export function resolveIceServers(): Promise<RTCIceServer[]> {
  return resolveIcePlan().then((p) => p.servers);
}

/** A log-safe summary of an ICE list: what kinds of server, never any secret. */
/** Strip any userinfo someone embedded in a relay URL before logging it. */
const redactUrl = (url: string) => url.replace(/\/\/[^/@]*@/, "//***@");

export function describeIce(list: RTCIceServer[]): string {
  return list
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).map((u) => redactUrl(String(u))).join(" | ");
      const kind = urls.includes("turn") ? (s.credential ? "turn (credentialed)" : "turn") : "stun";
      return `${kind}: ${urls}`;
    })
    .join("  ·  ");
}

export type IceFailureKind =
  | "relay-missing"
  | "relay-auth"
  | "relay-unreachable"
  | "relay-blocked"
  | "no-candidates";

/**
 * Turn a dead connection into an actionable sentence.
 *
 * The old messages guessed ("if you are both on mobile data…") no matter what
 * had actually happened. This one reads the plan and the candidates the browser
 * really gathered, so "no relay exists", "the relay rejected us", "the relay is
 * configured but unreachable" and "nothing was gathered at all" stop looking
 * like the same failure.
 */
export function diagnoseIceFailure(input: {
  relay: IcePlan["relay"];
  note?: string;
  issue?: IcePlanIssue;
  /** ms epoch the relay credentials expire, when the endpoint told us */
  expiresAt?: number;
  now?: number;
  tally: CandidateTally;
  iceState?: string;
}): { kind: IceFailureKind; text: string; detail: string } {
  const { relay, note, tally } = input;
  const found = `${tally.host} local, ${tally.srflx} reflexive, ${tally.prflx} peer-reflexive, ${tally.relay} relay`;
  const expired = Boolean(input.expiresAt && input.expiresAt <= (input.now ?? Date.now()));
  // Console-only: keeps the player-facing sentence short while leaving the
  // evidence needed to diagnose a real failure in a bug report.
  const detail = `candidates ${found}; ICE ${input.iceState ?? "unknown"}; relay ${relay}${
    input.issue && input.issue !== "none" ? ` (${input.issue})` : ""
  }${expired ? " [credentials expired]" : ""}${note ? ` — ${note}` : ""}`;
  if (tally.total === 0) {
    return {
      kind: "no-candidates",
      text: "No network route could be gathered at all — check this device's connection, firewall or DNS and try again.",
      detail,
    };
  }
  if (relay === "none") {
    // There are several distinct ways to have no relay. Saying "set TURN_URLS"
    // after a CORS failure or a missing VITE_CONVEX_SITE_URL sent operators to
    // the wrong dashboard.
    if (input.issue === "endpoint-unreachable") {
      return {
        kind: "relay-missing",
        text: `No direct route through this network, and the relay credential endpoint could not be reached (${note ?? "network or CORS failure"}). Check the deployed Convex site URL, its /turn route and TURN_ALLOWED_ORIGINS.`,
        detail,
      };
    }
    if (input.issue === "endpoint-rejected") {
      return {
        kind: "relay-missing",
        text: `No direct route through this network. The relay credential endpoint answered "${note ?? "an error"}" — check TURN_URLS / TURN_SECRET and TURN_ALLOWED_ORIGINS on the Convex deployment.`,
        detail,
      };
    }
    if (input.issue === "no-endpoint") {
      return {
        kind: "relay-missing",
        text: "No direct route through this network, and this build has no Convex site URL to ask for relay credentials. Set VITE_CONVEX_SITE_URL (or VITE_CONVEX_URL) and redeploy the frontend.",
        detail,
      };
    }
    if (input.issue === "static-invalid") {
      return {
        kind: "relay-missing",
        text: "No direct route through this network, and the static relay variables are invalid. VITE_TURN_URLS needs turn:/turns: URLs plus a username and credential.",
        detail,
      };
    }
    return {
      kind: "relay-missing",
      text: "No direct route through this network, and no relay is configured. The host must set TURN_URLS + TURN_SECRET on the Convex deployment.",
      detail,
    };
  }
  if (tally.relay === 0 && expired) {
    return {
      kind: "relay-auth",
      text: "The relay credentials had expired before this attempt, so only a direct route was tried, and this network blocks one. Rejoin to fetch fresh credentials.",
      detail,
    };
  }
  if (tally.relay === 0 && note && /credential|HTTP \d|reach|401|403|reject/i.test(note)) {
    return {
      kind: "relay-auth",
      text: "The relay rejected its credentials, so only a direct route was tried, and this network blocks one. Check TURN_URLS / TURN_SECRET.",
      detail,
    };
  }
  if (tally.relay === 0) {
    return {
      kind: "relay-unreachable",
      text: "A relay is configured but did not answer from this network. Use a turns: URL on port 443 so it survives restrictive firewalls.",
      detail,
    };
  }
  return {
    kind: "relay-blocked",
    text: "The relay answered but could not carry the session. Use a turns: URL on port 443, and check that the relay allows data channels.",
    detail,
  };
}

const IDLE: NetPlayerState = {
  x: 0, y: 0.2, z: 38, yaw: Math.PI, pitch: 0,
  hp: 120, alive: false, moving: false, firing: false, weapon: "RIFLE",
  epoch: 0, seq: 0,
};

/** A short, readable, unambiguous room code (no O/0, no I/1). */
export function makeRoomCode(): string {
  return drawRoomCode();
}

export class NetSession {
  readonly code: string;
  readonly isHost: boolean;
  name: string;
  /** our own peer id, known once the broker accepts us */
  me = "";
  phase: "connecting" | "lobby" | "playing" | "closed" = "connecting";

  /** page callbacks — always installed through setHandlers() */
  private handlers: NetHandlers = {};
  /** where our own state comes from, polled 20× a second */
  private stateProvider: (() => NetPlayerState) | null = null;

  /**
   * Install (or replace) the page's callbacks. Deliberately a method rather
   * than a public field: React treats props as immutable, and a page assigning
   * into `session.handlers` is exactly the kind of mutation that makes the
   * compiler's assumptions wrong.
   */
  setHandlers(patch: NetHandlers) {
    Object.assign(this.handlers, patch);
  }

  /** Hand the net layer the function that reads our own transform. */
  setStateProvider(fn: (() => NetPlayerState) | null) {
    this.stateProvider = fn;
  }

  private peer: Peer | null = null;
  /** the ICE servers and where the relay came from; cached until credentials expire */
  private plan: IcePlan = { servers: STUN_ONLY, relay: "none", issue: "unconfigured" };
  /** guest only: how many data channels we have created while connecting */
  private attempts = 0;
  private dialTimer = 0;
  private retryTimer = 0;
  /** a channel that has already been reported dead, so one failure is spoken once */
  private failedDials = new WeakSet<DataConnection>();
  /** guest only: the candidates gathered for the current attempt */
  private tally: CandidateTally = emptyTally();
  /** per-connection candidate counts, kept for diagnostics (never credentials) */
  private connTally = new WeakMap<DataConnection, CandidateTally>();
  /** per-connection selected candidate-pair type, when it was measured */
  private connPair = new WeakMap<DataConnection, string>();
  /** heartbeat that notices a peer which stopped talking without saying so */
  private sweepTimer = 0;
  private conns = new Map<string, DataConnection>();
  /** newest inbound/outbound channel per peer, so a stale close cannot drop it */
  private latest = new Map<string, DataConnection>();
  private roster = new Map<string, { name: string; ink: number }>();
  private scores = new Map<string, { kills: number; deaths: number }>();
  private lastState: Record<string, NetPlayerState> = {};
  private lastSeen = new Map<string, number>();
  private sendTimer = 0;
  private snapshot: NetPlayer[] = [];
  /** host only: the newest transform per player, flushed as one packet a tick */
  private pendingState = new Map<string, NetPlayerState>();
  /** our own measured round trip, ms */
  private rtt = 0;
  private pingTimer = 0;
  /** the match rules; guests adopt the host's copy */
  private config: MatchConfig;
  /** lobby ready flags, host-authoritative */
  private ready = new Map<string, boolean>();

  /* ----------------------------- signaling state ----------------------------- */
  /** broker endpoint, fixed for the life of the session */
  private broker: BrokerConfig = BROKER;
  private signalState: SignalState = "idle";
  private signalAttempts = 0;
  private signalTimer = 0;
  private signalWatchdog = 0;
  private signalFailure: SignalFailure | null = null;
  /** `connect()` is idempotent; React StrictMode and pageshow can both call it */
  private started = false;
  /** the broker has accepted our id right now */
  private brokerOpen = false;
  /** guest: the host's roster confirmed that we are in the room */
  private joinedRoom = false;
  private rejoinAttempts = 0;
  private rejoinTimer = 0;
  /** a signaling error that killed the dial in flight (not an ICE failure) */
  private dialFailure: SignalFailure | null = null;
  /** the one data channel currently being negotiated (guest only) */
  private pendingDial: DataConnection | null = null;
  /** a relay-credential refresh may be tried once per dial cycle */
  private iceRefreshUsed = false;

  /**
   * Half the measured round trip, capped at a quarter second.
   *
   * This one number fixes both ends of a laggy exchange: the shooter leads a
   * moving body by it, and the body rewinds by it when the shot arrives, so
   * both players agree about where the target was when the trigger was pulled.
   */
  get rewindMs() {
    return Math.min(250, Math.round(this.rtt / 2));
  }

  constructor(code: string, name: string, isHost: boolean, config: MatchConfig = { map: "district", grapple: true }) {
    this.code = code.toUpperCase();
    this.name = name.trim().slice(0, 16) || (isHost ? "HOST" : "GUEST");
    this.isHost = isHost;
    this.config = normalizeMatchConfig(config);
  }

  /** The host answers to a predictable id, so a code is all a guest needs. */
  get hostId() {
    return PREFIX + this.code;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  connect() {
    // Idempotent: StrictMode, a pageshow restore and an auto-join URL can all
    // ask for a connection; only the first one may create a Peer.
    if (this.started) return;
    this.started = true;
    void this.boot();
  }

  private get isClosed(): boolean {
    return this.phase === "closed";
  }

  private setSignal(state: SignalState, detail?: string) {
    if (this.signalState === state && detail === undefined) return;
    this.signalState = state;
    this.handlers.onSignal?.(state, detail);
  }

  /**
   * Resolve the ICE servers, then open signaling. The lookup can be a network
   * call (a credentials endpoint), which is why the Peer is created a beat
   * after `connect()` returns rather than inside it.
   */
  private async boot() {
    this.setSignal("connecting");
    try {
      this.plan = await resolveIcePlan();
    } catch (err) {
      // resolveIcePlan never rejects by design, but a broken polyfill must not
      // leave the lobby on "connecting" forever.
      console.warn(`[net ${this.code}] ICE plan failed`, err);
      this.plan = { servers: STUN_ONLY, relay: "none", issue: "unconfigured", note: "the ICE plan could not be resolved" };
    }
    const relay = this.plan.relay === "none" ? `STUN only (${this.plan.issue ?? "unconfigured"})` : `relay from ${this.plan.relay}`;
    console.info(`[net ${this.code}] ICE: ${describeIce(this.plan.servers)} · ${relay}`);
    if (this.plan.relay === "none") console.warn(`[net ${this.code}] relay unavailable — ${this.plan.note}`);
    console.info(`[net ${this.code}] signaling: ${describeBroker(this.broker)}`);
    if (this.phase === "closed") return; // the page left while we were looking
    window.clearInterval(this.sweepTimer);
    this.sweepTimer = window.setInterval(() => this.sweepSilent(), 2000);
    this.startPinging();
    const problem = brokerConfigProblem(this.broker, typeof location === "undefined" ? "https:" : location.protocol);
    if (problem) {
      // The socket will fail either way; say why before the generic retry text.
      console.warn(`[net ${this.code}] ${problem}`);
      this.handlers.onError?.(problem);
    }
    this.createPeer();
  }

  /** Build the signaling Peer. Only safe when no live data channel needs it. */
  private createPeer() {
    const options = { debug: 0, config: { iceServers: this.plan.servers } };
    this.brokerOpen = false;
    const peer = this.isHost ? new Peer(this.hostId, options) : new Peer(options);
    this.peer = peer;
    peer.on("open", (id) => this.onBrokerOpen(id));
    peer.on("connection", (conn) => this.adopt(conn));
    peer.on("disconnected", () => this.onBrokerLost("the broker closed this browser's signaling socket"));
    peer.on("error", (err) => this.onPeerError(err));
    this.armSignalWatchdog();
  }

  /** Destroy the signaling Peer after removing its listeners (no late callbacks). */
  private destroyPeer() {
    const peer = this.peer;
    this.peer = null;
    this.brokerOpen = false;
    if (!peer) return;
    peer.removeAllListeners();
    try {
      peer.destroy();
    } catch {
      /* already gone */
    }
  }

  private armSignalWatchdog() {
    window.clearTimeout(this.signalWatchdog);
    this.signalWatchdog = window.setTimeout(() => {
      this.signalWatchdog = 0;
      if (this.phase === "closed" || this.brokerOpen) return;
      const failure = classifySignalError({ type: "signal-timeout" }, this.broker);
      console.warn(`[net ${this.code}] signaling watchdog: ${failure.detail}`);
      this.scheduleSignalRetry(failure);
    }, SIGNAL_OPEN_TIMEOUT_MS);
  }

  /** The broker accepted our id. Runs again after every successful reconnect. */
  private onBrokerOpen(id: string) {
    window.clearTimeout(this.signalWatchdog);
    this.signalWatchdog = 0;
    this.signalAttempts = 0;
    this.signalFailure = null;
    this.brokerOpen = true;
    this.me = id;
    this.setSignal("open");
    if (this.isHost) {
      // The host's own row means "this room exists on the broker and is
      // accepting guests", which is exactly the moment it becomes true.
      this.roster.set(id, { name: this.name, ink: 0 });
      this.ready.set(id, true);
      if (this.phase === "connecting") this.phase = "lobby";
      if (this.phase === "lobby") this.handlers.onStatus?.("WAITING FOR YOUR FRIEND…");
      // After a reconnect, guests may have missed the roster; re-announce it.
      this.sendRoster();
      this.publish();
      return;
    }
    // Guest: an already-open channel is a live match and must not be redialled.
    if (!this.conns.has(this.hostId) && this.phase !== "playing") this.dialHost();
    else this.publish();
  }

  /** The signaling socket dropped. Never tear down the game channel for this. */
  private onBrokerLost(detail: string) {
    if (this.phase === "closed") return;
    this.brokerOpen = false;
    const failure = classifySignalError({ type: "network", message: detail }, this.broker);
    console.warn(`[net ${this.code}] signaling lost (${failure.kind}): ${failure.detail}`);
    this.scheduleSignalRetry(failure);
    // An unreachable host room is no longer a room the roster may advertise.
    this.publish();
  }

  /**
   * Bounded reconnect/backoff. Each attempt is one PeerJS `reconnect()` (same
   * peer id, existing data channels untouched) or, when there is no peer left
   * and no channel to protect, a fresh Peer.
   *
   * The old code called `peer.reconnect()` straight from the `disconnected`
   * handler. PeerJS emits `disconnected` from inside its own failure path, so
   * that reconnected synchronously, failed synchronously, and looped — an
   * unbounded reconnect storm against the broker, with no state the lobby could
   * display. This one is scheduled, counted and reported.
   */
  private scheduleSignalRetry(failure: SignalFailure) {
    if (this.phase === "closed") return;
    this.signalFailure = failure;
    if (!failure.retriable) {
      this.setSignal("lost", failure.text);
      this.handlers.onError?.(failure.text);
      return;
    }
    if (this.signalTimer) return; // one retry in flight at a time
    const delay = nextSignalBackoff(this.signalAttempts);
    if (delay === null) {
      this.setSignal("lost", "every reconnect attempt failed");
      this.handlers.onError?.(exhaustedSignalText(failure, MAX_SIGNAL_ATTEMPTS));
      this.publish();
      return;
    }
    this.publish();
    this.signalAttempts++;
    this.setSignal("retrying", `attempt ${this.signalAttempts} of ${MAX_SIGNAL_ATTEMPTS} in ${delay}ms`);
    this.signalTimer = window.setTimeout(() => {
      this.signalTimer = 0;
      if (this.phase === "closed" || this.brokerOpen) return;
      this.retrySignaling();
    }, delay);
  }

  private retrySignaling() {
    if (this.phase === "closed") return;
    const peer = this.peer;
    if (peer && !peer.destroyed) {
      if (peer.open) {
        this.onBrokerOpen(peer.id ?? this.me);
        return;
      }
      if (peer.disconnected) {
        try {
          peer.reconnect(); // same id, live data channels preserved
          this.armSignalWatchdog();
          return;
        } catch (err) {
          console.warn(`[net ${this.code}] reconnect() refused`, err);
        }
      } else {
        // Still "connecting" from the previous attempt: the socket is wedged.
        // Destroy it, but only when there is no data channel to keep alive.
        if (this.conns.size > 0) {
          this.setSignal("retrying", "signaling is down; the match connection is still live");
          return;
        }
      }
    }
    if (this.conns.size > 0) {
      // Existing WebRTC channels do not need signaling. Keep playing; rebuild
      // signaling only once they are gone.
      this.setSignal("retrying", "signaling is down; the match connection is still live");
      return;
    }
    this.destroyPeer();
    this.createPeer();
  }

  private onPeerError(err: { type?: string; message?: string }) {
    const failure = classifySignalError(err, this.broker);
    console.warn(`[net ${this.code}] signaling error (${failure.kind}): ${failure.detail}`);
    if (failure.kind === "room-in-use" || failure.kind === "invalid-key" || failure.kind === "incompatible") {
      this.brokerOpen = false;
      this.setSignal("lost", failure.kind);
      this.handlers.onError?.(failure.text);
      return;
    }
    if (failure.kind === "room-not-found") {
      // A late EXPIRE from an abandoned attempt must not scare a guest that is
      // already connected through the host's channel.
      if (!this.isHost && this.conns.has(this.hostId)) return;
      // The broker itself answered; the host is simply not registered. This is
      // a signaling/room failure, never an ICE or TURN failure.
      this.dialFailure = failure;
      this.brokerOpen = true;
      this.setSignal("open");
      const pending = this.pendingDial;
      if (!this.isHost && pending && !pending.open) this.failDial(pending, failure);
      else this.handlers.onError?.(failure.text);
      return;
    }
    this.brokerOpen = false;
    this.scheduleSignalRetry(failure);
  }

  /**
   * Open the data channel to the host — again, with a fresh peer connection, if
   * the first route dies.
   *
   * Renegotiating an ICE restart is not something PeerJS exposes (it handles a
   * single offer per connection), so the reliable recovery is a whole new
   * connection. A second attempt costs one handshake and routinely succeeds
   * where the first did not: the browser gathers a different set of reflexive
   * candidates, and a relay candidate that was still gathering at the 8-second
   * mark is now available. Before this the session simply sat on "negotiating"
   * forever and then blamed the player's network.
   */
  private dialHost() {
    const peer = this.peer;
    if (!peer || peer.destroyed || peer.disconnected || this.phase === "closed") return;
    if (this.conns.has(this.hostId) || this.pendingDial) return; // one dial at a time
    if (!this.brokerOpen) {
      // The broker will fire `open` and we dial from there. Dialling while the
      // socket is down just queues offers that can never be delivered.
      return;
    }
    this.attempts++;
    this.dialFailure = null;
    this.tally = emptyTally();
    this.handlers.onStatus?.(
      this.attempts === 1 ? "FINDING YOUR FRIEND…" : "FIRST ROUTE FAILED — TRYING A FRESH CONNECTION…",
    );
    let conn: DataConnection;
    try {
      conn = peer.connect(this.hostId, { reliable: true });
    } catch (err) {
      console.warn(`[net ${this.code}] could not dial the host`, err);
      this.handlers.onError?.("The connection could not be opened. Check the code and try again.");
      return;
    }
    const tally = this.tally;
    this.connTally.set(conn, tally);
    this.pendingDial = conn;
    this.watchTransport(conn, "host", tally);
    window.clearTimeout(this.dialTimer);
    this.dialTimer = window.setTimeout(() => this.dialFailed(conn, tally), DIAL_TIMEOUT_MS);
    conn.on("open", () => {
      window.clearTimeout(this.dialTimer);
      this.dialTimer = 0;
      window.clearTimeout(this.rejoinTimer);
      this.rejoinTimer = 0;
      this.dialFailure = null;
      this.iceRefreshUsed = false; // a future incident may refresh once again
      if (this.pendingDial === conn) this.pendingDial = null;
      // Newest wins: a retry that lands after an older attempt must replace it,
      // and the older channel must not be able to drop the live one later.
      const previous = this.conns.get(this.hostId);
      this.conns.set(this.hostId, conn);
      this.latest.set(this.hostId, conn);
      if (previous && previous !== conn) {
        try {
          previous.close();
        } catch {
          /* already gone */
        }
      }
      // Membership is NOT assumed here: the roster arrives from the host, and
      // only that confirms we are actually in the room.
      this.joinedRoom = false;
      this.rejoinAttempts = 0;
      this.ready.set(this.me, false);
      this.send({ t: "hello", name: this.name }, conn);
      this.handlers.onStatus?.("CONNECTED TO THE HOST — JOINING THE ROOM…");
      this.publish();
    });
    conn.on("data", (d) => this.receive(this.hostId, d));
    conn.on("close", () => {
      if (this.pendingDial === conn) this.pendingDial = null;
      if (this.latest.get(this.hostId) === conn) {
        this.latest.delete(this.hostId);
        this.drop(this.hostId);
      }
    });
    conn.on("error", (err) => {
      const type = (err as { type?: string } | undefined)?.type;
      if (type === "peer-unavailable") {
        const failure = classifySignalError(err as { type?: string; message?: string }, this.broker);
        this.dialFailure = failure;
        this.failDial(conn, failure);
        return;
      }
      if (type === "negotiation-failed") this.dialFailed(conn, tally);
      else this.channelError(conn, err);
    });
  }

  /**
   * One dial attempt is dead.
   *
   * The guest retries once with a fresh connection while the lobby is still
   * connecting, then explains what actually failed (see `diagnoseIceFailure`).
   * The host has nobody to dial: it stays put and the guest's retry arrives as
   * a new inbound connection, which `adopt` picks up under the same peer id.
   * A failure after the channel was open is left to the normal drop/sweep path.
   */
  private clearDialTimers() {
    window.clearTimeout(this.dialTimer);
    this.dialTimer = 0;
  }

  private closeQuietly(conn: DataConnection | null | undefined) {
    if (!conn) return;
    if (this.pendingDial === conn) this.pendingDial = null;
    try {
      conn.close();
    } catch {
      /* already gone */
    }
  }

  private dialFailed(conn: DataConnection, tally: CandidateTally) {
    if (this.phase === "closed" || conn.open) return;
    if (this.failedDials.has(conn)) return;
    // If signaling already explained this dial, do not overwrite that with an
    // ICE/TURN sentence. This is the exact bug behind the guest screenshot:
    // an unregistered host was reported as "no relay configured".
    if (this.dialFailure) {
      this.failDial(conn, this.dialFailure);
      return;
    }
    this.failedDials.add(conn);
    this.clearDialTimers();
    const pc = conn.peerConnection;
    const diagnosis = diagnoseIceFailure({
      relay: this.plan.relay,
      note: this.plan.note,
      issue: this.plan.issue,
      expiresAt: this.plan.expiresAt,
      tally,
      iceState: pc?.iceConnectionState,
    });
    console.warn(`[net ${this.code}] dial ${this.attempts} failed (${diagnosis.kind}): ${diagnosis.text} · ${diagnosis.detail}`);
    if (this.isHost) {
      // wait for the guest to redial; a close here is already handled by adopt()
      return;
    }
    this.closeQuietly(conn);
    // A rejected or expired relay credential is worth exactly one refresh +
    // retry. It is not a reason to loop, and it is not a reason to tell the
    // player to check their Wi-Fi.
    if (diagnosis.kind === "relay-auth" && !this.iceRefreshUsed) {
      this.iceRefreshUsed = true;
      void this.retryWithFreshIce(diagnosis.text);
      return;
    }
    this.retryOrReport(diagnosis.text);
  }

  /** A signaling error (host not registered, …) ended this dial. */
  private failDial(conn: DataConnection, failure: SignalFailure) {
    if (this.phase === "closed" || conn.open) return;
    if (this.failedDials.has(conn)) return;
    this.failedDials.add(conn);
    this.clearDialTimers();
    this.closeQuietly(conn);
    console.warn(`[net ${this.code}] dial ${this.attempts} failed (signaling ${failure.kind}): ${failure.detail}`);
    this.retryOrReport(failure.text);
  }

  private retryOrReport(text: string) {
    if (this.phase === "closed") return;
    if (this.attempts < MAX_DIALS) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = 0;
        if (this.phase === "connecting" || this.phase === "lobby") this.dialHost();
      }, RETRY_DELAY_MS);
      return;
    }
    this.handlers.onError?.(text);
    this.handlers.onStatus?.("NOT CONNECTED — THE ROOM IS STILL WAITING");
    this.publish();
  }

  /**
   * Fetch a fresh relay credential and retry once with it.
   *
   * Only the guest can do this cheaply: it has no live data channel during a
   * failed dial, so its signaling Peer can be rebuilt with the new ICE list.
   * The host refreshes its plan on a visibility resume while it is idle (see
   * `resume()`), which is when its credentials matter for the next guest.
   */
  private async retryWithFreshIce(previous: string) {
    if (this.phase === "closed") return;
    this.handlers.onStatus?.("RELAY CREDENTIALS EXPIRED — FETCHING FRESH ONES…");
    let plan: IcePlan;
    try {
      plan = await resolveIcePlan(true);
    } catch {
      this.retryOrReport(previous);
      return;
    }
    this.plan = plan;
    if (this.isClosed || this.conns.size > 0) return;
    if (plan.relay === "none") {
      this.retryOrReport(previous);
      return;
    }
    console.info(`[net ${this.code}] refreshed ICE: ${describeIce(plan.servers)} · relay from ${plan.relay}`);
    this.destroyPeer();
    this.attempts = 0;
    this.dialFailure = null;
    this.createPeer(); // dials again when the broker accepts the new peer
  }

  /**
   * Follow one connection's ICE lifecycle.
   *
   * Cross-network play fails at this layer and nowhere else, and "it never
   * connected" is not a diagnosis. The candidate types say whether a direct
   * path was ever possible; a `relay` candidate appearing is proof the TURN
   * server is reachable, and a pair stuck in `checking` with no relay candidate
   * is the signature of a missing relay. Verbose here is development-only: the
   * console is not where a production player should meet their diagnostics.
   */
  private watchTransport(conn: DataConnection, who: string, tally: CandidateTally) {
    const tag = `[net ${this.code}] ${who}`;
    const pc = conn.peerConnection;
    conn.on("iceStateChanged", (state) => {
      netLog(`${tag} ICE ${state}`);
      if (state === "failed") this.dialFailed(conn, tally);
    });
    if (pc) {
      pc.addEventListener("icegatheringstatechange", () => netLog(`${tag} gathering ${pc.iceGatheringState}`));
      pc.addEventListener("connectionstatechange", () => {
        netLog(`${tag} connection ${pc.connectionState}`);
        if (pc.connectionState === "failed") this.dialFailed(conn, tally);
      });
      pc.addEventListener("icecandidate", (e) => {
        if (!e.candidate) return;
        const c = e.candidate;
        const kind = c.type === "relay" ? "relay" : c.type === "srflx" ? "srflx" : c.type === "prflx" ? "prflx" : "host";
        tally[kind]++;
        tally.total++;
        netLog(`${tag} candidate ${kind} ${c.protocol} ${c.address}:${c.port}`);
      });
      conn.on("open", () => void this.reportSelectedPair(conn, tag));
    }
  }

  /** Record which path actually won, and whether it went through the relay. */
  private async reportSelectedPair(conn: DataConnection, tag: string) {
    const pc = conn.peerConnection;
    if (!pc?.getStats) return;
    try {
      const report = await pc.getStats();
      let local = "unknown";
      let remote = "unknown";
      report.forEach((s) => {
        if (s.type !== "candidate-pair") return;
        const pair = s as RTCIceCandidatePairStats;
        if (pair.state !== "succeeded") return;
        const l = pair.localCandidateId ? report.get(pair.localCandidateId) : undefined;
        const r = pair.remoteCandidateId ? report.get(pair.remoteCandidateId) : undefined;
        const lc = l as { candidateType?: string; protocol?: string } | undefined;
        const rc = r as { candidateType?: string; protocol?: string } | undefined;
        if (lc) local = `${lc.candidateType}/${lc.protocol}`;
        if (rc) remote = `${rc.candidateType}/${rc.protocol}`;
      });
      this.connPair.set(conn, `local ${local} ← remote ${remote}`);
      netLog(`${tag} selected path: local ${local} ← remote ${remote}`);
      if (local.startsWith("relay") || remote.startsWith("relay")) netLog(`${tag} TURN relay is carrying this match`);
    } catch (err) {
      netLog(`${tag} getStats failed`, err);
    }
  }

  close() {
    if (this.phase === "closed") return;
    try {
      this.send({ t: "bye" });
    } catch {
      /* the socket is already gone */
    }
    this.phase = "closed";
    this.joinedRoom = false;
    this.brokerOpen = false;
    this.setSignal("closed");
    window.clearInterval(this.sendTimer);
    window.clearInterval(this.sweepTimer);
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.dialTimer);
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.rejoinTimer);
    window.clearTimeout(this.signalTimer);
    window.clearTimeout(this.signalWatchdog);
    this.dialTimer = 0;
    this.retryTimer = 0;
    this.rejoinTimer = 0;
    this.signalTimer = 0;
    this.signalWatchdog = 0;
    // Remove listeners before destroy: PeerJS emits `disconnected` from inside
    // `destroy()`, and a live listener would try to reconnect a dead peer.
    this.destroyPeer();
    this.conns.clear();
    this.latest.clear();
    this.pendingDial = null;
  }

  /* ------------------------------- messaging ------------------------------- */

  /**
   * Adopt an inbound channel (host) — newest wins.
   *
   * A guest that retries opens a second channel under the same peer id. The old
   * code kept the first channel and registered the new one only if the id was
   * free, then let *any* close event drop the peer. A stale retry closing after
   * the good channel opened therefore removed a connected player. Now the
   * newest channel is the one the roster talks to, and a close from an older
   * channel is ignored.
   */
  private adopt(conn: DataConnection) {
    const tally = emptyTally();
    this.connTally.set(conn, tally);
    this.watchTransport(conn, conn.peer, tally);
    const register = () => {
      const previous = this.conns.get(conn.peer);
      // The newest *open* channel wins. Merely arriving is not enough: a
      // retry that never opens must not displace the connection that works.
      this.conns.set(conn.peer, conn);
      this.latest.set(conn.peer, conn);
      if (previous && previous !== conn) {
        try {
          previous.close();
        } catch {
          /* already gone */
        }
      }
    };
    if (conn.open) register();
    else conn.on("open", register);
    conn.on("data", (d) => {
      if (this.conns.get(conn.peer) === conn) this.receive(conn.peer, d);
    });
    conn.on("close", () => {
      // Identity check: a superseded retry closing must not drop the live one.
      if (this.conns.get(conn.peer) !== conn) return;
      this.latest.delete(conn.peer);
      this.drop(conn.peer);
    });
    conn.on("error", (err) => this.channelError(conn, err));
  }

  private drop(id: string) {
    const had = this.conns.has(id) || this.roster.has(id);
    if (!had) return;
    const hostLost = !this.isHost && id === this.hostId;
    const gone = this.roster.get(id)?.name ?? "A PLAYER";
    this.conns.delete(id);
    this.latest.delete(id);
    this.roster.delete(id);
    delete this.lastState[id];
    this.lastSeen.delete(id);
    this.pendingState.delete(id);
    this.scores.delete(id);
    if (hostLost) {
      // The host's channel is the whole guest session: anything cached from the
      // host's roster is no longer confirmed membership.
      this.joinedRoom = false;
      this.roster.clear();
      this.ready.clear();
      this.lastState = {};
      this.lastSeen.clear();
      this.pendingState.clear();
      this.scores.clear();
      if (this.phase !== "playing") this.phase = "connecting";
      this.handlers.onStatus?.("LOST THE HOST — TRYING TO REJOIN…");
      this.scheduleRejoin();
    } else if (id !== this.me && this.phase !== "closed") {
      this.handlers.onFeed?.(`${gone} LEFT THE MATCH`, false);
    }
    // Tell the page too: its own cache of that player's position is the thing
    // that would otherwise be re-used at the next spawn.
    this.handlers.onPeerGone?.(id);
    if (this.isHost) this.sendRoster();
    this.publish();
    if (this.isHost && this.conns.size === 0 && !this.brokerOpen && this.phase !== "closed") {
      // The host kept a dead signaling socket only to protect live channels;
      // now that none are left it can rebuild it.
      this.scheduleSignalRetry(this.signalFailure ?? classifySignalError({ type: "network" }, this.broker));
    }
  }

  /**
   * Re-dial the host after an established channel closed. Bounded, and only in
   * the lobby: a played match that loses its link should say so, not pretend a
   * rejoin is seamless.
   */
  private scheduleRejoin() {
    if (this.isHost || this.phase === "closed" || this.phase === "playing") return;
    if (this.rejoinTimer || this.conns.has(this.hostId)) return;
    if (this.rejoinAttempts >= MAX_REJOINS) {
      this.handlers.onError?.("Lost the connection to the host and could not get back in. Check the room code, then join again.");
      return;
    }
    const delay = nextSignalBackoff(this.rejoinAttempts) ?? 8000;
    this.rejoinAttempts++;
    this.rejoinTimer = window.setTimeout(() => {
      this.rejoinTimer = 0;
      if (this.phase === "closed" || this.conns.has(this.hostId)) return;
      this.attempts = 0;
      this.dialHost();
    }, delay);
  }

  /**
   * Drop peers that have gone quiet.
   *
   * A phone that walks out of signal never sends `close` — the socket simply
   * stops, and the browser may not notice for minutes. Without this the roster
   * keeps a player who is not there, their last transform stays cached as "where
   * they are", and the next spawn or rematch re-uses a body that no longer
   * exists. Only while playing: in the lobby nothing ticks, so silence means
   * nothing.
   */
  private sweepSilent() {
    if (this.phase !== "playing") return;
    const now = performance.now();
    for (const [id, at] of [...this.lastSeen]) {
      if (id === this.me || now - at < SILENCE_MS) continue;
      this.drop(id);
    }
  }

  /**
   * Send through one channel, and never let one bad channel take the rest down.
   *
   * PeerJS throws synchronously if a channel closed between the `open` check
   * and the send, and that throw used to escape into whichever loop was
   * broadcasting — one dead peer and the whole tick stopped for everyone, which
   * at four players is exactly the "two or three of us dropped" report. A
   * channel that is merely not open yet is skipped, not punished: only a throw
   * means it is really gone.
   */
  private safeSend(conn: DataConnection | undefined, env: Envelope): "sent" | "skip" | "dead" {
    if (!conn || !conn.open) return "skip";
    try {
      conn.send(env);
      return "sent";
    } catch (err) {
      console.warn(`[net ${this.code}] send to ${conn.peer} failed`, err);
      return "dead";
    }
  }

  /** A data-channel error is only a disconnect if the channel is really shut. */
  private channelError(conn: DataConnection, err: unknown) {
    if (conn.open) {
      console.warn(`[net ${this.code}] channel ${conn.peer} reported an error but is still open`, err);
      return;
    }
    // A dead attempt must never keep the next dial blocked.
    if (this.pendingDial === conn) this.pendingDial = null;
    // Only the current channel for that peer may drop it; a superseded retry
    // failing later must not remove the live one.
    if (this.conns.get(conn.peer) === conn) this.drop(conn.peer);
  }

  /** Only the channel the roster currently uses may drop that peer. */
  private dropIfCurrent(conn: DataConnection) {
    if (this.conns.get(conn.peer) === conn || this.latest.get(conn.peer) === conn) this.drop(conn.peer);
  }

  private send(msg: NetMsg, conn?: DataConnection) {
    const env: Envelope = { ...msg, from: this.me, name: this.name, ink: this.roster.get(this.me)?.ink ?? 0 };
    const one = conn;
    if (one) {
      if (this.safeSend(one, env) === "dead") this.dropIfCurrent(one);
      return;
    }
    const dead: DataConnection[] = [];
    for (const c of this.conns.values()) if (this.safeSend(c, env) === "dead") dead.push(c);
    for (const c of dead) this.dropIfCurrent(c);
  }

  /** Hand a message on untouched — the sender's id has to survive the trip. */
  private forward(env: Envelope, conn?: DataConnection) {
    const one = conn;
    if (one) {
      if (this.safeSend(one, env) === "dead") this.dropIfCurrent(one);
      return;
    }
    const dead: DataConnection[] = [];
    for (const c of this.conns.values()) if (this.safeSend(c, env) === "dead") dead.push(c);
    for (const c of dead) this.dropIfCurrent(c);
  }

  private sendRoster() {
    const list: RosterEntry[] = [...this.roster.entries()].map(([id, v]) => ({
      id,
      name: v.name,
      ink: v.ink,
      ready: id === this.me ? this.isHost : (this.ready.get(id) ?? false),
    }));
    this.forward({ t: "roster", list, from: this.me });
  }

  /** Host: tell one peer (or the whole room) what this match is configured as. */
  private sendConfig(conn?: DataConnection) {
    if (conn) this.forward({ t: "config", config: this.config, from: this.me }, conn);
    else this.forward({ t: "config", config: this.config, from: this.me });
  }

  /** Host: everybody but the sender. Guest: the host. */
  private relayToOthers(sender: string, env: Envelope) {
    const dead: DataConnection[] = [];
    for (const [id, c] of this.conns) {
      if (id === sender) continue;
      if (this.safeSend(c, env) === "dead") dead.push(c);
    }
    for (const c of dead) this.dropIfCurrent(c);
  }

  private receive(from: string, raw: unknown) {
    const env = raw as Envelope;
    if (!env || typeof env.t !== "string") return;
    this.lastSeen.set(from, performance.now());

    if (!this.isHost) {
      // A guest hears every peer through the host, already routed to them — so
      // the sender is whoever put the envelope together, not the host in front
      // of it. Reading `from` here would file every other guest under the
      // host's id the moment a third player joins.
      const src = env.from || from;
      if (env.t === "roster") {
        // the host's list is the truth: replace ours wholesale so a player who
        // left does not linger on the scoreboard
        const list = Array.isArray(env.list) ? env.list : [];
        this.roster.clear();
        this.ready.clear();
        for (const r of list) {
          if (!r || typeof r.id !== "string") continue;
          this.roster.set(r.id, { name: String(r.name ?? "PLAYER"), ink: Number(r.ink) || 0 });
          this.ready.set(r.id, r.ready === true);
        }
        // Membership is the host's confirmation, not our own optimism. Until
        // the host lists us we are still joining: IN THE ROOM stays empty.
        const confirmed = this.me !== "" && this.roster.has(this.me);
        if (confirmed && !this.joinedRoom) {
          this.joinedRoom = true;
          this.rejoinAttempts = 0;
          this.phase = this.phase === "playing" ? "playing" : "lobby";
          this.handlers.onStatus?.("IN THE ROOM — READY WHEN YOU ARE");
        }
        this.publish();
        return;
      }
      if (env.t === "state") {
        this.applyState(src, env.s);
        return;
      }
      if (env.t === "states") {
        // One packet per tick from the host, carrying every other body. Ours is
        // in there too — we are the authority on it, so it is skipped rather
        // than echoed back into the avatar list.
        for (const e of env.list) if (e.id !== this.me) this.applyState(e.id, e.s);
        return;
      }
      if (env.t === "hit") {
        if (env.victim === this.me) this.takeHit(env.dmg, src, env.epoch, env.origin);
        return;
      }
      if (env.t === "full") {
        this.handlers.onError?.("That match is full — it holds four players. The host can run a rematch to free a slot.");
        // No point holding a channel that will never carry a snapshot.
        this.close();
        return;
      }
      if (env.t === "config") {
        this.config = normalizeMatchConfig(env.config);
        this.handlers.onConfig?.(this.config);
        return;
      }
      if (env.t === "pong") {
        this.noteRtt(env.t0);
        return;
      }
      this.apply(src, env);
      return;
    }

    /* -------------------------- host: the hub -------------------------- */
    if (env.t === "hello") {
      // The star has one host, so "full" is the host's call — and saying so is
      // kinder than letting a fifth player hold a connection that will never
      // receive a snapshot.
      if (!this.roster.has(from) && this.roster.size >= MAX_PLAYERS) {
        this.forward({ t: "full", from: this.me }, this.conns.get(from));
        return;
      }
      this.roster.set(from, { name: String(env.name ?? "PLAYER").slice(0, 16), ink: this.freeInk(from) });
      this.lastState[from] = this.lastState[from] ?? { ...IDLE };
      this.ready.set(from, false);
      this.handlers.onFeed?.(`${this.roster.get(from)?.name ?? "A PLAYER"} JOINED`, false);
      this.sendRoster();
      // A newcomer needs the rules even if the host never touches them again.
      this.sendConfig(this.conns.get(from));
      // A friend who turns up mid-match drops straight into the arena with
      // everyone else instead of waiting for a start that already happened.
      if (this.phase === "playing") this.send({ t: "start", config: this.config }, this.conns.get(from));
      this.publish();
      return;
    }
    if (env.t === "ready") {
      this.ready.set(from, env.ready === true);
      this.sendRoster();
      this.publish();
      return;
    }
    if (env.t === "hit") {
      // A hit only ever interests one person: the one who took it.
      if (env.victim === this.me) this.takeHit(env.dmg, from, env.epoch, env.origin);
      else this.forward(env, this.conns.get(env.victim));
      return;
    }
    if (env.t === "state") {
      // Held, not relayed on arrival: every guest's body is folded into the
      // next single snapshot (see tick()). Three guests cost three packets out
      // per tick instead of nine, and each one receives a single ordered stream
      // instead of three interleaved ones. Only transforms that passed the gate
      // are held — a late-arriving packet must not be handed to everyone else,
      // which is exactly how a single reordered packet became lobby-wide jitter.
      if (this.applyState(from, env.s)) this.pendingState.set(from, env.s);
      return;
    }
    if (env.t === "ping") {
      this.forward({ t: "pong", t0: env.t0, from: this.me }, this.conns.get(from));
      return;
    }
    if (env.t === "pong") {
      this.noteRtt(env.t0);
      return;
    }
    this.apply(from, env);
    if (env.t !== "bye") this.relayToOthers(from, env);
  }

  private freeInk(id: string) {
    const used = new Set([...this.roster.entries()].filter(([k]) => k !== id).map(([, v]) => v.ink));
    for (let i = 0; i < 6; i++) if (!used.has(i)) return i;
    return this.roster.size % 6;
  }

  /** Returns true when the transform was applied (and is worth passing on). */
  private applyState(id: string, s: NetPlayerState): boolean {
    if (!shouldApplyState(this.lastState[id], s)) return false;
    this.lastState[id] = s;
    this.handlers.onRemoteState?.(id, s);
    return true;
  }

  private apply(from: string, env: Envelope) {
    const who = this.roster.get(from)?.name ?? "A PLAYER";
    switch (env.t) {
      case "death": {
        this.bump(env.killer, { kills: 1 });
        this.bump(from, { deaths: 1 });
        const killer = this.roster.get(env.killer)?.name;
        this.handlers.onFeed?.(
          env.killer === from ? `${who} ERASED THEMSELVES` : `${killer ?? "SOMEONE"} ERASED ${who}`,
          env.killer === this.me || from === this.me,
        );
        this.handlers.onDeath?.(from, env.killer);
        this.publish();
        break;
      }
      case "respawn":
        this.handlers.onRespawn?.(from, env.epoch ?? 0);
        this.publish();
        break;
      case "start":
        // The start packet is the last word on the rules: a guest who joined
        // late, or missed an earlier config packet, builds the same match as
        // the host. This is what makes the host's choice authoritative.
        if (env.config) {
          this.config = normalizeMatchConfig(env.config);
          this.handlers.onConfig?.(this.config);
        }
        if (!this.isHost) this.joinedRoom = true;
        this.phase = "playing";
        this.handlers.onStart?.(this.config);
        break;
      case "rematch":
        this.beginRematch();
        break;
      case "bye":
        this.drop(from);
        break;
      default:
        break;
    }
  }

  private bump(id: string, add: { kills?: number; deaths?: number }) {
    if (!id) return;
    const cur = this.scores.get(id) ?? { kills: 0, deaths: 0 };
    this.scores.set(id, { kills: cur.kills + (add.kills ?? 0), deaths: cur.deaths + (add.deaths ?? 0) });
  }

  private takeHit(dmg: number, killer: string, epoch: number, origin: NetShotOrigin) {
    this.handlers.onHitMe?.(dmg, killer, epoch ?? 0, origin);
  }

  /**
   * Clear the board for a fresh round, on every client.
   *
   * Scores live in this class and the victory overlay is *derived* from them —
   * `kills >= KILLS_TO_WIN` on each screen. A rematch that only restarts the
   * engine leaves those numbers at fifteen, so the overlay comes straight back
   * up and the button that was supposed to dismiss it is the only thing you can
   * see. Resetting here is what makes `winner` false again everywhere.
   */
  private beginRematch() {
    this.scores.clear();
    this.pendingState.clear();
    this.phase = "playing";
    this.handlers.onRematch?.();
    this.publish();
  }

  /* -------------------------------- actions -------------------------------- */

  /**
   * Called from the shooter's engine the instant a round lands on a remote.
   *
   * `victimEpoch` is the body the shooter aimed at (the victim drops the hit if
   * they have respawned since) and `origin` is where the shot came from, so the
   * victim can check the path against the world instead of taking our word.
   */
  reportHit(victim: string, dmg: number, victimEpoch: number, origin: NetShotOrigin) {
    if (victim === this.me || this.phase !== "playing") return;
    this.send({ t: "hit", victim, dmg, epoch: victimEpoch, origin });
  }

  reportDeath(killer: string) {
    this.send({ t: "death", killer });
    this.bump(this.me, { deaths: 1 });
    if (killer && killer !== this.me) this.bump(killer, { kills: 1 });
    else this.bump(this.me, { kills: 1 });
    this.publish();
  }

  /** `epoch` is the generation of the body that just teleported to a pad. */
  reportRespawn(epoch: number) {
    this.send({ t: "respawn", epoch });
  }

  /** Host only: everyone drops into the arena together, under these rules. */
  beginMatch() {
    this.scores.clear();
    this.phase = "playing";
    this.send({ t: "start", config: this.config });
    this.handlers.onStart?.(this.config);
    this.publish();
  }

  /** The match rules this client will build. Guests mirror the host's copy. */
  getConfig(): MatchConfig {
    return this.config;
  }

  /** Host only: change the map or grapple rule and broadcast it to the room. */
  setConfig(patch: Partial<MatchConfig>) {
    if (!this.isHost) return;
    this.config = normalizeMatchConfig({ ...this.config, ...patch });
    this.sendConfig();
    this.handlers.onConfig?.(this.config);
    this.publish();
  }

  /** Mark ourselves ready / not ready. The host is always ready. */
  setReady(ready: boolean) {
    if (this.isHost) return;
    // A ready flag is only meaningful once the host has confirmed membership.
    if (!this.joinedRoom || !this.conns.has(this.hostId)) return;
    this.ready.set(this.me, ready);
    this.send({ t: "ready", ready });
    this.publish();
  }

  get isReady(): boolean {
    return this.isHost || (this.ready.get(this.me) ?? false);
  }

  /**
   * Host only: run the match again.
   *
   * One broadcast is enough — every client already holds its own scoreboard, so
   * each clears it locally from this message and the engine is restarted from
   * the page's `onRematch`. Nobody has to be teleported by the host: the
   * respawn that follows stamps a new epoch, and the snapshot gate turns that
   * into a snap for every peer instead of a slide.
   */
  rematch() {
    if (!this.isHost) return;
    this.send({ t: "rematch" });
    this.beginRematch();
  }

  /** Push our transform to the room 20× a second. */
  startTicking() {
    window.clearInterval(this.sendTimer);
    this.sendTimer = window.setInterval(() => this.tick(), 50);
  }

  /**
   * One tick of the state stream.
   *
   * A guest sends its own body to the host. The host sends *everyone's* newest
   * body to each guest in one packet — the multiplex that keeps four players on
   * one uplink alive, because the host's outbound cost stops growing with the
   * square of the lobby and each guest has exactly one stream to de-jitter.
   */
  private tick() {
    if (this.phase === "closed" || !this.stateProvider) return;
    const s = this.stateProvider();
    if (!this.isHost) {
      this.lastState[this.me] = s;
      this.send({ t: "state", s });
      return;
    }
    this.lastState[this.me] = s;
    this.pendingState.set(this.me, s);
    const list = [...this.pendingState].map(([id, st]) => ({ id, s: st }));
    this.pendingState.clear();
    if (list.length > 0) this.forward({ t: "states", list, from: this.me });
  }

  /* --------------------------------- latency -------------------------------- */

  /**
   * A heartbeat that measures the one hop that matters: us to the host.
   *
   * Half of it is the correct rewind for a shot that had to cross the network
   * before it could be validated, and the correct lead for aiming at a body
   * that will have moved by the time our shot is checked.
   */
  private startPinging() {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => this.sendPing(), 2000);
  }

  private sendPing() {
    if (this.phase === "closed" || this.conns.size === 0) return;
    this.send({ t: "ping", t0: performance.now() });
  }

  /** A pong carries our own timestamp back; the echo is the round trip. */
  private noteRtt(t0: number) {
    const ms = performance.now() - t0;
    if (!Number.isFinite(ms) || ms < 0 || ms > 5000) return;
    // Eased, so one slow heartbeat cannot swing the rewind window by 200 ms.
    this.rtt = this.rtt === 0 ? ms : this.rtt * 0.7 + ms * 0.3;
    this.handlers.onLatency?.(this.rewindMs);
  }

  /* --------------------------------- status --------------------------------- */

  /** Broker state for the lobby — never inferred from the local roster. */
  get signaling(): SignalState {
    return this.signalState;
  }

  /**
   * Are we a confirmed member of the room?
   *
   * Host: the broker accepted the host id (or people are actually connected).
   * Guest: the host's roster listed us. This is deliberately stricter than
   * "we created a Peer" and "we opened a data channel" — the two states that
   * used to make IN THE ROOM (1) appear on a room that could not accept guests.
   */
  get joined(): boolean {
    if (this.isHost) return this.brokerOpen || this.conns.size > 0 || this.phase === "playing";
    return this.joinedRoom;
  }

  /** The broker host/port/path, for the lobby's diagnostics line. */
  get brokerLabel(): string {
    return describeBroker(this.broker);
  }

  /**
   * Everything a bug report needs, and nothing a bug report must not have.
   * No username, credential, token or SDP is included.
   */
  diagnostics(): NetDiagnostics {
    const now = Date.now();
    return {
      code: this.code,
      role: this.isHost ? "host" : "guest",
      broker: describeBroker(this.broker),
      signaling: this.signalState,
      signalingAttempts: this.signalAttempts,
      joined: this.joined,
      relay: this.plan.relay,
      relayIssue: this.plan.issue ?? "none",
      relayNote: this.plan.note ?? "",
      relayExpiresInMs: this.plan.expiresAt ? Math.max(0, this.plan.expiresAt - now) : null,
      iceServers: describeIce(this.plan.servers),
      browserOnline: typeof navigator === "undefined" ? true : navigator.onLine,
      peers: [...this.conns.entries()].map(([id, conn]) => ({
        id,
        open: Boolean(conn.open),
        ice: conn.peerConnection?.iceConnectionState ?? "unknown",
        connection: conn.peerConnection?.connectionState ?? "unknown",
        candidates: this.connTally.get(conn) ?? emptyTally(),
        path: this.connPair.get(conn) ?? "not measured",
      })),
    };
  }

  /* ------------------------------ page lifecycle ----------------------------- */

  /**
   * The tab is visible again (or came back from bfcache).
   *
   * Browsers throttle timers in hidden tabs, and a sleeping Windows laptop or a
   * backgrounded phone can drop the broker socket entirely. Re-check signaling
   * and redial only if there is no live channel. Never create a new room: the
   * code and the lease belong to the session, not to a timer.
   */
  resume() {
    if (this.phase === "closed") return;
    if (!this.brokerOpen) {
      if (this.signalState === "lost") {
        // An exhausted cycle may be sitting on a wedged socket (never open,
        // never disconnected). A visible tab is a user action, so start one
        // fresh bounded cycle — but only when nothing live would be destroyed.
        this.signalAttempts = 0;
        if (this.conns.size === 0) {
          this.destroyPeer();
          this.createPeer();
          void this.refreshIdleIce();
          return;
        }
      }
      if (this.signalTimer) return;
      if (!this.peer || this.peer.destroyed) {
        if (this.conns.size === 0) this.createPeer();
      } else if (this.peer.open) {
        this.onBrokerOpen(this.peer.id ?? this.me);
      } else if (this.peer.disconnected) {
        this.scheduleSignalRetry(classifySignalError({ type: "disconnected" }, this.broker));
      } else {
        this.armSignalWatchdog();
      }
    } else if (!this.isHost && !this.conns.has(this.hostId) && !this.pendingDial && this.phase !== "playing") {
      this.dialHost();
    }
    void this.refreshIdleIce();
  }

  /** Rebuild signaling with fresh TURN credentials while nothing is connected. */
  private async refreshIdleIce() {
    if (this.phase === "closed" || this.conns.size > 0 || this.pendingDial) return;
    const expiresAt = this.plan.expiresAt;
    if (!expiresAt || expiresAt - Date.now() > TURN_REFRESH_SKEW_MS) return;
    const before = describeIce(this.plan.servers);
    const plan = await resolveIcePlan(true);
    if (this.isClosed) return;
    this.plan = plan;
    this.iceRefreshUsed = false;
    if (plan.relay === "none" || describeIce(plan.servers) === before) return;
    console.info(`[net ${this.code}] refreshed idle ICE: ${describeIce(plan.servers)} · relay from ${plan.relay}`);
    if (this.conns.size > 0) return;
    this.destroyPeer();
    this.signalAttempts = 0;
    this.createPeer();
  }

  /**
   * The page is really going away (a reload or navigation, not bfcache).
   * Best-effort goodbye, then a deterministic teardown. The room lease is kept
   * by the page, so a reload can resume the same code.
   */
  suspend() {
    this.close();
  }

  /* --------------------------------- roster --------------------------------- */

  getPlayers(): NetPlayer[] {
    return this.snapshot;
  }

  private publish() {
    const list: NetPlayer[] = [];
    // A guest has no confirmed membership until the host's roster says so.
    if (this.isHost || this.joinedRoom) {
      for (const [id, info] of this.roster) {
        if (id === this.me && !this.joined) continue; // not reachable yet
        list.push(this.row(id, info));
      }
    }
    list.sort((a, b) => Number(b.isHost) - Number(a.isHost) || b.kills - a.kills);
    this.snapshot = list;
    this.handlers.onChange?.();
  }

  private row(id: string, info: { name: string; ink: number }): NetPlayer {
    const score = this.scores.get(id) ?? { kills: 0, deaths: 0 };
    return {
      id,
      name: info.name,
      ink: info.ink,
      isMe: id === this.me,
      isHost: id === (this.isHost ? this.me : this.hostId),
      kills: score.kills,
      deaths: score.deaths,
      state: this.lastState[id] ?? { ...IDLE },
      online: id === this.me || performance.now() - (this.lastSeen.get(id) ?? 0) < 4000,
      ready: id === this.me ? this.isReady : (this.ready.get(id) ?? false),
    };
  }
}

export type NetDiagnostics = {
  code: string;
  role: "host" | "guest";
  broker: string;
  signaling: SignalState;
  signalingAttempts: number;
  joined: boolean;
  relay: IcePlan["relay"];
  relayIssue: IcePlanIssue;
  relayNote: string;
  relayExpiresInMs: number | null;
  iceServers: string;
  browserOnline: boolean;
  peers: {
    id: string;
    open: boolean;
    ice: string;
    connection: string;
    candidates: CandidateTally;
    path: string;
  }[];
};
