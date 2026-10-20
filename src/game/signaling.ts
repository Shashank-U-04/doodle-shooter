// Signaling broker configuration, retry policy and error classification.
//
// The broker is PeerJS: it introduces two browsers and is then out of the
// match. It is still a hard dependency of *discovery* — a guest cannot find a
// host on it is not reachable — so its failures are kept strictly separate from
// ICE/TURN failures. Everything here is pure so `scripts/check-net.ts` can test
// the policy without a browser or a live broker.

/** Where the signaling broker lives. Mirrors PeerJS's own option names. */
export type BrokerConfig = {
  host: string;
  port: number;
  path: string;
  key: string;
  secure: boolean;
};

/** The public PeerJS cloud broker, and PeerJS's own defaults. */
export const DEFAULT_BROKER: BrokerConfig = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  key: "peerjs",
  secure: true,
};

const truthy = (v: unknown) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
const falsy = (v: unknown) => /^(0|false|no|off)$/i.test(String(v ?? "").trim());

/**
 * Read the broker from Vite env.
 *
 * A deployment can point at its own PeerServer (`VITE_PEER_HOST`, …) without a
 * code change; unset means the shared public cloud broker. The host and port
 * are not secrets, so this is safe to bundle.
 */
export function readBrokerConfig(env: Record<string, unknown> = {}): BrokerConfig {
  const host = String(env.VITE_PEER_HOST ?? "").trim() || DEFAULT_BROKER.host;
  const rawPort = Number.parseInt(String(env.VITE_PEER_PORT ?? ""), 10);
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : DEFAULT_BROKER.port;
  let path = String(env.VITE_PEER_PATH ?? DEFAULT_BROKER.path).trim() || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (!path.endsWith("/")) path = `${path}/`;
  const key = String(env.VITE_PEER_KEY ?? "").trim() || DEFAULT_BROKER.key;
  const secureRaw = env.VITE_PEER_SECURE;
  const secure = falsy(secureRaw) ? false : truthy(secureRaw) ? true : DEFAULT_BROKER.secure;
  return { host, port, path, key, secure };
}

/** A log-safe description of the broker endpoint — never includes a key value? It does include the key. */
export function describeBroker(cfg: BrokerConfig): string {
  return `${cfg.secure ? "wss" : "ws"}://${cfg.host}:${cfg.port}${cfg.path}`;
}

/**
 * Catch a broker configuration the browser will refuse before it is even
 * attempted. An https game cannot open a ws:// socket: the browser blocks it as
 * mixed content and PeerJS reports the generic "Lost connection to server".
 */
export function brokerConfigProblem(cfg: BrokerConfig, pageProtocol: string): string | null {
  if (pageProtocol === "https:" && !cfg.secure) {
    return `the game is served over https but the signaling broker is ${describeBroker(cfg)} — the browser blocks plain ws:// as mixed content. Set VITE_PEER_SECURE=1 (or use a wss:// broker).`;
  }
  if (cfg.secure && cfg.port === 80) {
    return `the signaling broker is configured for wss:// on port 80 (${describeBroker(cfg)}); port 80 does not normally speak TLS.`;
  }
  return null;
}

/**
 * Bounded retry policy for the signaling socket.
 *
 * Five attempts with a doubling delay: 0.5s, 1s, 2s, 4s, 8s. After the last
 * one the session stops trying and says so. A tab that becomes visible again is
 * a user action and starts a fresh (still bounded) cycle — it is not an
 * infinite timer.
 */
export const SIGNAL_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MAX_SIGNAL_ATTEMPTS = SIGNAL_RETRY_DELAYS_MS.length;
/** How long one signaling attempt may take before it is declared dead. */
export const SIGNAL_OPEN_TIMEOUT_MS = 12_000;

/** Delay before retry number `attempt` (0-based), or null when exhausted. */
export function nextSignalBackoff(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return null;
  if (attempt >= SIGNAL_RETRY_DELAYS_MS.length) return null;
  return SIGNAL_RETRY_DELAYS_MS[Math.floor(attempt)];
}

export type SignalFailureKind =
  | "broker-unreachable"
  | "broker-timeout"
  | "room-in-use"
  | "room-not-found"
  | "invalid-key"
  | "incompatible"
  | "disconnected"
  | "unknown";

export type SignalFailure = {
  kind: SignalFailureKind;
  /** player-facing sentence, safe to display */
  text: string;
  /** console-only evidence, safe to log (never credentials) */
  detail: string;
  /** may a later attempt succeed? room-in-use / incompatible do not. */
  retriable: boolean;
};

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Turn a PeerJS peer/connection error into one of the states the lobby can
 * explain. This is the boundary the previous implementation did not have: it
 * sent every dead dial to the ICE/TURN diagnosis, so "the host is not
 * registered" was reported as "no relay is configured".
 */
export function classifySignalError(
  err: { type?: string; message?: string } | null | undefined,
  broker: BrokerConfig = DEFAULT_BROKER,
): SignalFailure {
  const type = String(err?.type ?? "");
  const message = clip(String(err?.message ?? ""));
  const where = describeBroker(broker);
  switch (type) {
    case "unavailable-id":
      return {
        kind: "room-in-use",
        text: "That room code is already held on the signaling broker. Someone else (or an older tab of yours) has it — leave and create a new room.",
        detail: `ID-TAKEN from ${where}${message ? `: ${message}` : ""}`,
        retriable: false,
      };
    case "peer-unavailable":
      return {
        kind: "room-not-found",
        text: "The host is not reachable on the signaling broker. The room may have closed, or the host's browser lost its broker connection. Ask the host to check the lobby status, then try again.",
        detail: `peer-unavailable from ${where}${message ? `: ${message}` : ""}`,
        retriable: true,
      };
    case "invalid-key":
      return {
        kind: "invalid-key",
        text: "The signaling broker rejected this app's key. Check VITE_PEER_KEY (or the broker's configuration).",
        detail: `invalid-key from ${where}${message ? `: ${message}` : ""}`,
        retriable: false,
      };
    case "browser-incompatible":
      return {
        kind: "incompatible",
        text: "This browser cannot do WebRTC, so online play is unavailable here.",
        detail: message || "browser-incompatible",
        retriable: false,
      };
    case "disconnected":
      return {
        kind: "disconnected",
        text: "The signaling connection was closed. Reconnecting…",
        detail: `disconnected${message ? `: ${message}` : ""}`,
        retriable: true,
      };
    case "signal-timeout":
      return {
        kind: "broker-timeout",
        text: `The signaling broker did not answer within ${Math.round(SIGNAL_OPEN_TIMEOUT_MS / 1000)} seconds.`,
        detail: `no OPEN from ${where} before the timeout`,
        retriable: true,
      };
    case "network":
    case "socket-error":
    case "server-error":
      return {
        kind: "broker-unreachable",
        text: "The signaling broker is unreachable from this browser. Reconnecting…",
        detail: `${type} from ${where}${message ? `: ${message}` : ""}`,
        retriable: true,
      };
    default:
      return {
        kind: "unknown",
        text: message ? `Signaling failed: ${message}` : "The signaling connection failed.",
        detail: `${type || "unknown"}${message ? `: ${message}` : ""}`,
        retriable: true,
      };
  }
}

/** Player-facing text once a bounded signaling cycle has run out. */
export function exhaustedSignalText(failure: SignalFailure, attempts: number): string {
  if (!failure.retriable) return failure.text;
  if (failure.kind === "broker-unreachable" || failure.kind === "broker-timeout") {
    return `Could not reach the signaling broker after ${attempts} attempts (${failure.detail}). This is a signaling problem, not a TURN/relay problem: check that this network allows WebSockets to the broker, or point the game at a broker it can reach.`;
  }
  return failure.text;
}
