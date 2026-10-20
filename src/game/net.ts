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
  onError?: (text: string) => void;
  /** the roster or a score changed — re-render */
  onChange?: () => void;
  /** a peer left (cleanly, or by going silent) — drop whatever we cached for them */
  onPeerGone?: (id: string) => void;
};

const PREFIX = "ds-pvp-";

/**
 * How long a peer may go quiet before we treat it as gone (ms).
 *
 * Generous on purpose: the host relays three other players' transforms, so a
 * guest on a mobile link can lose a couple of seconds to a stall and still be
 * in the match. Six seconds used to be "gone" and that is a drop, not a
 * disconnect — the player never left, the phone just hiccuped.
 */
const SILENCE_MS = 12000;

/** Hard ceiling on the lobby. The star topology does not scale past this. */
export const MAX_PLAYERS = 4;

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

export type IcePlan = {
  servers: RTCIceServer[];
  /** where the relay (if any) came from */
  relay: "none" | "static" | "endpoint" | "deployment";
  /** log-safe explanation when there is no relay, or the endpoint failed */
  note?: string;
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

/**
 * Resolve the complete ICE list once per page.
 *
 * Order matters: the deployment's own credential endpoint first (nothing
 * secret ships in the bundle and the relay can rotate without a redeploy),
 * then an explicitly configured third-party endpoint, then a static relay.
 * Whatever the outcome, the reason is recorded rather than swallowed.
 */
export function resolveIcePlan(): Promise<IcePlan> {
  if (icePlan) return icePlan;
  icePlan = (async (): Promise<IcePlan> => {
    const explicit = import.meta.env.VITE_TURN_CREDENTIALS_URL as string | undefined;
    const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
    const site =
      (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)?.replace(/\/+$/, "") ??
      convexUrl?.replace(/\.convex\.cloud\/?$/, ".convex.site");

    const endpoints: { url: string; relay: IcePlan["relay"] }[] = [];
    if (explicit) endpoints.push({ url: explicit, relay: "endpoint" });
    if (site) endpoints.push({ url: `${site}/turn`, relay: "deployment" });

    let note = "";
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint.url, { cache: "no-store" });
        if (!res.ok) {
          note = `the relay credential service answered HTTP ${res.status}`;
          continue;
        }
        const body = (await res.json()) as
          | RTCIceServer[]
          | { iceServers?: RTCIceServer[]; configured?: boolean; reason?: string };
        const raw = Array.isArray(body) ? body : (body.iceServers ?? []);
        const clean = sanitizeIceServers(raw);
        if (clean.relay > 0) {
          return { servers: [...STUN_ONLY, ...clean.servers], relay: endpoint.relay };
        }
        note =
          (!Array.isArray(body) && typeof body.reason === "string" && body.reason) ||
          "the relay credential service returned no usable TURN server";
        if (clean.dropped > 0) note += ` (${clean.dropped} rejected) `;
      } catch (err) {
        note = `the relay credential service could not be reached (${(err as Error)?.message ?? String(err)})`;
      }
    }

    const urls = String(import.meta.env.VITE_TURN_URLS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const username = import.meta.env.VITE_TURN_USERNAME as string | undefined;
    const credential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;
    if (urls.length > 0) {
      const clean = sanitizeIceServers([{ urls, username, credential }]);
      if (clean.relay > 0) return { servers: [...STUN_ONLY, ...clean.servers], relay: "static" };
      note = "VITE_TURN_URLS is not a turn:/turns: URL, or VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL is missing";
    }

    // Always a warning, never gated by NET_DEBUG: this is the one line that
    // explains most "it finds the room but never connects" reports.
    console.warn(
      `[net] No TURN relay available — ${note || "no relay is configured"}. ` +
        "Matches between networks that block direct peer traffic will fail; set TURN_URLS and TURN_SECRET on the Convex deployment.",
    );
    return { servers: STUN_ONLY, relay: "none", note: note || "no relay is configured" };
  })();
  return icePlan;
}

/** Compatibility shim: the ICE list alone, for anything that just wants servers. */
export function resolveIceServers(): Promise<RTCIceServer[]> {
  return resolveIcePlan().then((p) => p.servers);
}

/** A log-safe summary of an ICE list: what kinds of server, never any secret. */
export function describeIce(list: RTCIceServer[]): string {
  return list
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).join(" | ");
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
  tally: CandidateTally;
  iceState?: string;
}): { kind: IceFailureKind; text: string; detail: string } {
  const { relay, note, tally } = input;
  const found = `${tally.host} local, ${tally.srflx} reflexive, ${tally.prflx} peer-reflexive, ${tally.relay} relay`;
  // Console-only: keeps the player-facing sentence short while leaving the
  // evidence needed to diagnose a real failure in a bug report.
  const detail = `candidates ${found}; ICE ${input.iceState ?? "unknown"}; relay ${relay}${note ? ` — ${note}` : ""}`;
  if (tally.total === 0) {
    return {
      kind: "no-candidates",
      text: "No network route could be gathered at all — check this device's connection, firewall or DNS and try again.",
      detail,
    };
  }
  if (relay === "none") {
    return {
      kind: "relay-missing",
      text: "No direct route through this network, and no relay is configured. The host must set TURN_URLS + TURN_SECRET on the Convex deployment.",
      detail,
    };
  }
  if (tally.relay === 0 && note && /credential|HTTP \d|reach/i.test(note)) {
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
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
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
  /** the ICE servers and where the relay came from, resolved once per page */
  private plan: IcePlan = { servers: STUN_ONLY, relay: "none" };
  /** guest only: how many data channels we have created while connecting */
  private attempts = 0;
  private dialTimer = 0;
  private retryTimer = 0;
  /** a channel that has already been reported dead, so one failure is spoken once */
  private failedDials = new WeakSet<DataConnection>();
  /** guest only: the candidates gathered for the current attempt */
  private tally: CandidateTally = emptyTally();
  /** heartbeat that notices a peer which stopped talking without saying so */
  private sweepTimer = 0;
  private conns = new Map<string, DataConnection>();
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
    void this.boot();
  }

  /**
   * Resolve the ICE servers, then dial. The lookup can be a network call (a
   * credentials endpoint), which is why the Peer is created a beat after
   * `connect()` returns rather than inside it.
   */
  private async boot() {
    this.plan = await resolveIcePlan();
    const relay = this.plan.relay === "none" ? "STUN only" : `relay from ${this.plan.relay}`;
    console.info(`[net ${this.code}] ICE: ${describeIce(this.plan.servers)} · ${relay}`);
    if (this.plan.relay === "none") console.warn(`[net ${this.code}] relay unavailable — ${this.plan.note}`);
    if (this.phase === "closed") return; // the page left while we were looking
    window.clearInterval(this.sweepTimer);
    this.sweepTimer = window.setInterval(() => this.sweepSilent(), 2000);
    this.startPinging();
    if (this.isHost) this.startHosting();
    else this.startGuest();
  }

  private startHosting() {
    const peer = new Peer(this.hostId, { debug: 0, config: { iceServers: this.plan.servers } });
    this.peer = peer;
    peer.on("open", (id) => {
      this.me = id;
      this.roster.set(id, { name: this.name, ink: 0 });
      this.ready.set(id, true);
      this.phase = "lobby";
      this.handlers.onStatus?.("WAITING FOR YOUR FRIEND…");
      this.publish();
    });
    peer.on("connection", (conn) => this.adopt(conn));
    peer.on("disconnected", () => {
      // The broker drops us when its socket blips; a live match must not.
      if (this.phase !== "closed") peer.reconnect();
    });
    peer.on("error", (err) => this.fail(err));
  }

  private startGuest() {
    const peer = new Peer({ debug: 0, config: { iceServers: this.plan.servers } });
    this.peer = peer;
    peer.on("open", (id) => {
      this.me = id;
      this.dialHost();
    });
    peer.on("disconnected", () => {
      if (this.phase !== "closed") peer.reconnect();
    });
    peer.on("error", (err) => this.fail(err));
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
    if (!peer || peer.destroyed || this.phase === "closed") return;
    this.attempts++;
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
    this.watchTransport(conn, "host", tally);
    window.clearTimeout(this.dialTimer);
    this.dialTimer = window.setTimeout(() => this.dialFailed(conn, tally), DIAL_TIMEOUT_MS);
    conn.on("open", () => {
      window.clearTimeout(this.dialTimer);
      this.conns.set(this.hostId, conn);
      this.roster.set(this.hostId, { name: "HOST", ink: 0 });
      this.roster.set(this.me, { name: this.name, ink: 1 });
      this.ready.set(this.me, false);
      this.phase = "lobby";
      this.send({ t: "hello", name: this.name });
      this.handlers.onStatus?.("CONNECTED — WAITING FOR THE HOST TO START…");
      this.publish();
    });
    conn.on("data", (d) => this.receive(this.hostId, d));
    conn.on("close", () => {
      if (this.conns.get(this.hostId) === conn) this.drop(this.hostId);
    });
    conn.on("error", (err) => {
      const type = (err as { type?: string } | undefined)?.type;
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
  private dialFailed(conn: DataConnection, tally: CandidateTally) {
    if (this.phase === "closed" || conn.open) return;
    if (this.failedDials.has(conn)) return;
    this.failedDials.add(conn);
    window.clearTimeout(this.dialTimer);
    const pc = conn.peerConnection;
    const diagnosis = diagnoseIceFailure({
      relay: this.plan.relay,
      note: this.plan.note,
      tally,
      iceState: pc?.iceConnectionState,
    });
    console.warn(`[net ${this.code}] dial ${this.attempts} failed (${diagnosis.kind}): ${diagnosis.text} · ${diagnosis.detail}`);
    if (this.isHost) {
      // wait for the guest to redial; a close here is already handled by adopt()
      return;
    }
    try {
      conn.close();
    } catch {
      /* already gone */
    }
    if (this.attempts < MAX_DIALS) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => {
        if (this.phase === "connecting") this.dialHost();
      }, RETRY_DELAY_MS);
      return;
    }
    this.handlers.onError?.(diagnosis.text);
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

  /** Log which path actually won, and whether it went through the relay. */
  private async reportSelectedPair(conn: DataConnection, tag: string) {
    if (!NET_DEBUG) return;
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
    window.clearInterval(this.sendTimer);
    window.clearInterval(this.sweepTimer);
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.dialTimer);
    window.clearTimeout(this.retryTimer);
    this.peer?.destroy();
    this.peer = null;
    this.conns.clear();
  }

  /* ------------------------------- messaging ------------------------------- */

  private fail(err: { type?: string; message?: string }) {
    const type = err?.type ?? "";
    const text =
      type === "unavailable-id"
        ? "That match code is already taken — try creating another match."
        : type === "peer-unavailable"
          ? "Could not find that match. Check the code and try again."
          : type === "network" || type === "server-error" || type === "socket-error"
            ? "The connection broker is unreachable. Try again in a moment."
            : type === "negotiation-failed"
              ? "The two browsers could not agree on a route to each other."
              : type === "browser-incompatible"
              ? "This browser cannot do WebRTC, so online play is unavailable here."
              : err?.message || "Connection failed.";
    this.handlers.onError?.(text);
  }

  private adopt(conn: DataConnection) {
    this.watchTransport(conn, conn.peer, emptyTally());
    const register = () => {
      if (!this.conns.has(conn.peer)) this.conns.set(conn.peer, conn);
    };
    if (conn.open) register();
    else conn.on("open", register);
    conn.on("data", (d) => this.receive(conn.peer, d));
    conn.on("close", () => this.drop(conn.peer));
    conn.on("error", (err) => this.channelError(conn, err));
  }

  private drop(id: string) {
    const had = this.conns.has(id) || this.roster.has(id);
    if (!had) return;
    const gone = this.roster.get(id)?.name ?? "A PLAYER";
    this.conns.delete(id);
    this.roster.delete(id);
    delete this.lastState[id];
    this.lastSeen.delete(id);
    this.pendingState.delete(id);
    this.scores.delete(id);
    if (id !== this.me && this.phase !== "closed") this.handlers.onFeed?.(`${gone} LEFT THE MATCH`, false);
    // Tell the page too: its own cache of that player's position is the thing
    // that would otherwise be re-used at the next spawn.
    this.handlers.onPeerGone?.(id);
    if (this.isHost) this.sendRoster();
    this.publish();
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
    this.drop(conn.peer);
  }

  private send(msg: NetMsg, conn?: DataConnection) {
    const env: Envelope = { ...msg, from: this.me, name: this.name, ink: this.roster.get(this.me)?.ink ?? 0 };
    const one = conn;
    if (one) {
      if (this.safeSend(one, env) === "dead") this.drop(one.peer);
      return;
    }
    const dead: string[] = [];
    for (const [id, c] of this.conns) if (this.safeSend(c, env) === "dead") dead.push(id);
    for (const id of dead) this.drop(id);
  }

  /** Hand a message on untouched — the sender's id has to survive the trip. */
  private forward(env: Envelope, conn?: DataConnection) {
    const one = conn;
    if (one) {
      if (this.safeSend(one, env) === "dead") this.drop(one.peer);
      return;
    }
    const dead: string[] = [];
    for (const [id, c] of this.conns) if (this.safeSend(c, env) === "dead") dead.push(id);
    for (const id of dead) this.drop(id);
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
    const dead: string[] = [];
    for (const [id, c] of this.conns) {
      if (id === sender) continue;
      if (this.safeSend(c, env) === "dead") dead.push(id);
    }
    for (const id of dead) this.drop(id);
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
          this.roster.set(r.id, { name: r.name, ink: r.ink });
          this.ready.set(r.id, r.ready === true);
        }
        if (!this.roster.has(this.me)) this.roster.set(this.me, { name: this.name, ink: 1 });
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

  /* --------------------------------- roster --------------------------------- */

  getPlayers(): NetPlayer[] {
    return this.snapshot;
  }

  private publish() {
    const list: NetPlayer[] = [];
    for (const [id, info] of this.roster) list.push(this.row(id, info));
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
