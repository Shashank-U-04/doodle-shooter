// Which transport carries online play, and the surface the pages use from it.
//
// PeerJS (src/game/net.ts) is the default. `VITE_NET_TRANSPORT=colyseus` opts a
// build into the Colyseus lobby (src/game/colyseus.ts), which talks to the
// server in server/. Anything else, including unset, keeps PeerJS.
//
// Kept free of browser globals so the server's tests can import it under Node.

import type { MatchConfig } from "./maps";
import type { NetHandlers, NetPlayer } from "./net";
import type { NetCombatIntent, NetPlayerState, NetShotLanded, NetShotOrigin } from "./types";

export type NetTransport = "peerjs" | "colyseus";

type Env = Record<string, unknown>;

/** `import.meta.env` under Vite; empty under plain Node (scripts, tests). */
export function viteEnv(): Env {
  return ((import.meta as { env?: Env }).env ?? {}) as Env;
}

export function readNetTransport(env: Env): NetTransport {
  return String(env.VITE_NET_TRANSPORT ?? "").trim().toLowerCase() === "colyseus" ? "colyseus" : "peerjs";
}

/** The local server from server/README.md; only ever used by a development build. */
export const DEV_COLYSEUS_URL = "http://localhost:2567";

/**
 * Where the match server lives: `VITE_COLYSEUS_URL`, or the local server in a
 * development build. A production build without it has no server to talk to,
 * and says so instead of guessing.
 */
export function readColyseusUrl(env: Env): string | null {
  const raw = String(env.VITE_COLYSEUS_URL ?? "").trim();
  if (raw) return /^(https?|wss?):\/\/[^\s/]+/i.test(raw) ? raw.replace(/\/+$/, "") : null;
  return env.DEV ? DEV_COLYSEUS_URL : null;
}

export const NET_TRANSPORT: NetTransport = readNetTransport(viteEnv());

/** Who took the match, as the arena's overlay shows it. */
export type MatchWinner = { id: string; name: string; kills: number; isMe: boolean };

/**
 * The match's winner, or null while it is undecided.
 *
 * A server-refereed session names it (`winnerId`, "" while undecided), and its
 * word stands even if the winner has since left: combat stays stopped until a
 * rematch, so the overlay must stay up for the host. Otherwise (PeerJS) every
 * client derives it from the score it counted itself.
 */
export function matchWinner(players: NetPlayer[], winnerId: string | undefined, killsToWin: number): MatchWinner | null {
  if (winnerId === undefined) {
    const p = players.find((x) => x.kills >= killsToWin);
    return p ? { id: p.id, name: p.name, kills: p.kills, isMe: p.isMe } : null;
  }
  if (!winnerId) return null;
  const p = players.find((x) => x.id === winnerId);
  return p
    ? { id: p.id, name: p.name, kills: p.kills, isMe: p.isMe }
    : { id: winnerId, name: "A PLAYER WHO LEFT", kills: killsToWin, isMe: false };
}

/**
 * Callbacks a session may call. The PeerJS session only ever uses NetHandlers;
 * the server-authoritative ones are the Colyseus session's.
 */
export type MatchHandlers = NetHandlers & {
  /** the server confirmed one of our attacks landed */
  onShotLanded?: (hit: NetShotLanded) => void;
  /** the server took health off us (`killerId` null: our own grenade, a trap) */
  onHurt?: (damage: number, killerId: string | null) => void;
  /** the server's word on our health, whenever it changes */
  onHealth?: (hp: number, alive: boolean, killerId: string | null) => void;
  /** the session is over for good (server restarted or unreachable, seat gone); the arena must stop */
  onLost?: (text: string) => void;
};

/**
 * Everything Online.tsx uses from a session. NetSession satisfies it as is;
 * ColyseusSession implements it over the server.
 */
export interface MatchSession {
  readonly code: string;
  readonly isHost: boolean;
  /** our own id within the room, once known */
  readonly me: string;
  /** the room has confirmed our seat */
  readonly joined: boolean;
  /** half the measured round trip, for the engine's aim model */
  readonly rewindMs: number;
  connect(): void;
  close(): void;
  resume(): void;
  suspend(): void;
  setHandlers(patch: MatchHandlers): void;
  getPlayers(): NetPlayer[];
  getConfig(): MatchConfig;
  setConfig(patch: Partial<MatchConfig>): void;
  setReady(ready: boolean): void;
  beginMatch(): void;
  rematch(): void;
  setStateProvider(fn: (() => NetPlayerState) | null): void;
  startTicking(): void;
  reportHit(victim: string, dmg: number, victimEpoch: number, origin: NetShotOrigin): void;
  reportDeath(killer: string): void;
  reportRespawn(epoch: number): void;
  /** log-safe connection details for a console warning */
  diagnostics(): unknown;
  /** true when the server decides hits and health (the engine then sends intents) */
  readonly serverCombat?: boolean;
  /** server combat: hand an attack to the server */
  reportCombat?(intent: NetCombatIntent): void;
  /** server combat: the winner the server declared ("" while undecided) */
  readonly winnerId?: string;
}
