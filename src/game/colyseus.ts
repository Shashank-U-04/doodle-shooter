// Online lobby over the Colyseus match server (server/), behind
// VITE_NET_TRANSPORT=colyseus. PeerJS (net.ts) stays the default.
//
// The server owns the roster, ready flags, match rules and the decision to
// start; this class only mirrors its state into the shape Online.tsx already
// renders (NetPlayer rows, NetHandlers callbacks).
//
// In the arena, our engine's body goes up as a `move` message MOVE_RATE_HZ
// times a second and every other body comes back in the room state, as the
// server validated it (server/src/movement.ts), through the same
// onRemoteState/onPeerGone callbacks the PeerJS transport uses — so the engine
// draws remote players exactly as it does over WebRTC.
//
// Combat is the server's (server/src/rooms/Combat.ts): the engine's attacks
// arrive here as intents and go up with a shot id and a lag estimate; the
// server's verdicts come back as `hit` / `eliminated` events and as health,
// kills and deaths in the state. Nothing this client claims can hurt anyone.
//
// Reloads: the server holds a dropped seat for a short window, and only the
// holder of that seat's reconnection token can take it back. The token is kept
// in sessionStorage (one tab, one seat) and used before any fresh join, so a
// reload resumes the same seat instead of adding a second one.

import type { Client, Room } from "@colyseus/sdk";
import { normalizeMatchConfig, type MatchConfig } from "./maps";
import type { NetPlayer, SignalState } from "./net";
import type { NetCombatIntent, NetPlayerState, NetShotOrigin } from "./types";
import { readColyseusUrl, viteEnv, type MatchHandlers, type MatchSession } from "./transport";
import { MOVE_RATE_HZ, NAME_MAX, RECONNECT_SECONDS, SERVER_CLOSING_MESSAGE } from "../../server/src/shared/rules.js";

/** sessionStorage key for this tab's seat; separate from the PeerJS lease. */
export const SEAT_KEY = "dd_colyseus_seat";
/** A stored seat older than this is not worth a reconnection attempt. */
const SEAT_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * How long after the page unloads its seat is still held: the server's
 * RECONNECT_SECONDS (server/src/shared/rules.ts), less a little for the round trip.
 */
export const RESUME_WINDOW_MS = RECONNECT_SECONDS * 1000 - 2000;

/**
 * How long matchmaking may take before the lobby says why: a free-tier host
 * that has spun down takes about a minute to wake, and the SDK has no timeout.
 */
export const WAKE_HINT_MS = 5000;
export const WAKE_HINT = "WAKING THE MATCH SERVER — A SLEEPING SERVER CAN TAKE UP TO A MINUTE…";
/**
 * How long connecting may take in all before the lobby gives up and offers TRY
 * AGAIN: room for a sleeping host to wake, with margin. Without it an
 * unreachable server left the lobby on JOINING… for good.
 */
export const JOIN_TIMEOUT_MS = 90_000;
export const JOIN_TIMEOUT_TEXT = "The match server did not answer in time. It may still be waking up — press TRY AGAIN.";
/** What the arena says when the match server restarted (or redeployed) under a match. */
const RESTARTED_TEXT = "The match server restarted, so this match has ended. Create or join a match again.";

/** @colyseus/shared-types CloseCode.SERVER_SHUTDOWN (not imported: the SDK loads on demand) */
const SERVER_SHUTDOWN = 4001;
/**
 * @colyseus/shared-types CloseCode, for the connection log only: what each code
 * means, so a failure report reads "WITH_ERROR (server closed us)" rather than
 * a bare number. Codes not listed are logged as the number alone.
 */
const CLOSE_CODES: Record<number, string> = {
  1000: "NORMAL_CLOSURE",
  1001: "GOING_AWAY (server or page went away; SDK retries)",
  1005: "NO_STATUS_RECEIVED (SDK retries)",
  1006: "ABNORMAL_CLOSURE (socket died without a close frame: network loss, or SDK reconnect refused)",
  4000: "CONSENTED (a deliberate leave)",
  4001: "SERVER_SHUTDOWN",
  4002: "WITH_ERROR (the server closed us: e.g. rate limit or a rejected message)",
  4003: "FAILED_TO_RECONNECT (SDK gave up after its retries)",
  4010: "MAY_TRY_RECONNECT (SDK retries)",
};

/** How often the round trip is measured, ms. */
const PING_EVERY_MS = 2000;
/**
 * How far behind the server our view of other bodies is, beyond the round
 * trip: up to one patch (50 ms) plus the engine's easing toward each new
 * position (~70 ms). The server rewinds bodies by round trip + this (capped).
 */
const VIEW_DELAY_MS = 100;

/** server/src/rooms/Combat.ts events */
type HitEvent = { attacker: string; victim: string; weapon: string; damage: number; head: boolean; kill: boolean; x: number; y: number; z: number };
type EliminatedEvent = { victim: string; killer: string; weapon: string };

/** What the server answers to `start` (server/src/rooms/MatchRoom.ts). */
type StartResult = { ok: true } | { ok: false; reason: string };

/** The synced room state, as `state.toJSON()` returns it. */
type RoomJSON = {
  code?: string;
  phase?: string;
  map?: string;
  grapple?: boolean;
  maxPlayers?: number;
  hostId?: string;
  winnerId?: string;
  round?: number;
  players?: Record<string, PlayerJSON>;
};

type PlayerJSON = {
  id: string;
  name: string;
  ink: number;
  isHost: boolean;
  ready: boolean;
  connected: boolean;
  spawned?: boolean;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  moving?: boolean;
  firing?: boolean;
  alive?: boolean;
  weapon?: string;
  epoch?: number;
  hp?: number;
  kills?: number;
  deaths?: number;
};

type Seat = {
  code: string;
  token: string;
  isHost: boolean;
  createdAt: number;
  /** when the page holding the seat unloaded; absent while it is open */
  leftAt?: number;
};
type SeatStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const IDLE: NetPlayerState = {
  x: 0, y: 0.2, z: 38, yaw: Math.PI, pitch: 0,
  hp: 100, alive: false, moving: false, firing: false, weapon: "RIFLE",
  epoch: 0, seq: 0,
};

const START_REFUSALS: Record<string, string> = {
  "not-host": "Only the host can start the match.",
  "not-in-lobby": "The match has already started.",
  "no-guests": "Wait for at least one friend to join before starting.",
  "guests-not-ready": "Everyone has to be ready before the match can start.",
  "guest-reconnecting": "A friend is reconnecting — wait a moment, then start.",
};

function readSeat(storage: SeatStorage | null, now: number): Seat | null {
  try {
    const value = JSON.parse(storage?.getItem(SEAT_KEY) ?? "null") as Partial<Seat> | null;
    if (!value || typeof value.code !== "string" || typeof value.token !== "string") return null;
    if (typeof value.isHost !== "boolean" || typeof value.createdAt !== "number") return null;
    if (value.leftAt !== undefined && typeof value.leftAt !== "number") return null;
    if (now - value.createdAt > SEAT_TTL_MS || value.createdAt > now + 60_000) return null;
    return value as Seat;
  } catch {
    return null;
  }
}

function writeSeat(storage: SeatStorage | null, seat: Seat) {
  try {
    storage?.setItem(SEAT_KEY, JSON.stringify(seat));
  } catch {
    /* storage is unavailable; a reload will join fresh */
  }
}

/**
 * The seat this tab can take back right now without asking anyone: one whose
 * page unloaded (reload, tab restore) inside the server's hold window.
 *
 * The lobby cannot rely on the URL for this: it takes a guest's `?room=` off
 * the URL once it has read it (and Convex Auth strips an old `?code=` link's),
 * so the room code is gone by the time the page is reloaded.
 */
export function resumableSeat(storage: SeatStorage | null, now: number): { code: string; isHost: boolean } | null {
  const seat = readSeat(storage, now);
  if (!seat || seat.leftAt === undefined) return null;
  if (now - seat.leftAt > RESUME_WINDOW_MS || seat.leftAt > now + 60_000) return null;
  return { code: seat.code, isHost: seat.isHost };
}

function clearSeat(storage: SeatStorage | null) {
  try {
    storage?.removeItem(SEAT_KEY);
  } catch {
    /* nothing to clear */
  }
}

function defaultStorage(): SeatStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Matchmaking failures, in the lobby's voice. */
export function describeJoinError(err: unknown, code: string, url: string): string {
  const e = err as { code?: number; message?: string } | null;
  const message = String(e?.message ?? "");
  if (e?.code === 522 && /locked/i.test(message)) return "That match is full — it holds four players.";
  if (e?.code === 522) return `No match with code ${code} — check it with your friend.`;
  if (/origin not allowed/i.test(message)) {
    return "The match server does not accept this site. Add this origin to the server's ALLOWED_ORIGINS.";
  }
  if (typeof e?.code === "number" && e.code > 0) return `The match server refused: ${message || `error ${e.code}`}`;
  // A refused origin also lands here: the browser hides the response when CORS
  // does not name this site, so it looks exactly like an unreachable server.
  return `Could not reach the match server at ${url}. Check that it is running and that this site is in its ALLOWED_ORIGINS.`;
}

/** Colyseus' close code for leaving on purpose. */
const CONSENTED = 4000;

/**
 * Leave a room on purpose.
 *
 * The SDK's consented leave tells the server (LEAVE_ROOM) and waits for the
 * server to close the socket with CONSENTED. Through the Render deployment that
 * server-initiated close never arrives: socket traces on 2026-10-24 showed every
 * close the server starts reaching the client as an abnormal 1006 about 20 s
 * later, while a close the client starts completes in one round trip (the same
 * build, run locally, closes cleanly every time). The SDK read that 1006 as a
 * dropped connection and spent a minute reconnecting to a seat the server had
 * already removed.
 *
 * So: announce the leave (the server handles it first, in order, as a consented
 * leave), close the socket from this side with the same code, and never
 * reconnect. Resolves with the close code, CONSENTED when all went well.
 */
export function leaveRoom(room: Room): Promise<number> {
  room.reconnection.enabled = false;
  const left = room.leave(true);
  room.connection?.close(CONSENTED, "consented");
  return left;
}

// The SDK chunk, loaded once per page, on demand: a PeerJS build never downloads it.
let sdkLoad: Promise<typeof import("@colyseus/sdk")> | null = null;
function loadSdk() {
  sdkLoad ??= import("@colyseus/sdk").catch((err) => {
    sdkLoad = null; // a failed chunk load may succeed on the next try
    throw err;
  });
  return sdkLoad;
}

let warmed = false;
/**
 * The online lobby is open: fetch the SDK and knock on the server while the
 * player is still typing a name or a code, so CREATE / CONNECT does not start
 * from a cold chunk, a cold TLS connection, or a server only now beginning to
 * wake. The knock is the public /health probe, fire-and-forget; its answer is
 * not read, so it needs nothing from the server's CORS rules.
 */
export function warmColyseus(url: string | null = readColyseusUrl(viteEnv())) {
  if (warmed || !url) return;
  warmed = true;
  void loadSdk().catch(() => {});
  try {
    void fetch(`${url.replace(/^ws/i, "http")}/health`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
  } catch {
    // no fetch here (tests, old browsers): connecting works the same without it
  }
}

export type ColyseusSessionDeps = {
  /** server URL; defaults to VITE_COLYSEUS_URL (or the local server in dev) */
  url?: string | null;
  /** where this tab's seat is kept; defaults to sessionStorage */
  storage?: SeatStorage | null;
  /**
   * Only take back this tab's held seat; never create or join a new room.
   * Used when the lobby resumes on its own after a reload.
   */
  resumeOnly?: boolean;
  /** how long connecting may take before giving up; JOIN_TIMEOUT_MS by default */
  joinTimeoutMs?: number;
};

export class ColyseusSession implements MatchSession {
  /** the room code; empty for a host until the server has made the room */
  code: string;
  readonly isHost: boolean;
  name: string;
  me = "";
  phase: "connecting" | "lobby" | "playing" | "closed" = "connecting";
  readonly rewindMs = 0;
  readonly serverCombat = true;

  private readonly url: string | null;
  private readonly storage: SeatStorage | null;
  private readonly resumeOnly: boolean;
  private readonly joinTimeoutMs: number;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  /** connection diagnostics (logConnection) */
  private attachedAt = 0;
  private drops = 0;
  private lastDropAt = 0;
  private handlers: MatchHandlers = {};
  private room: Room | null = null;
  private config: MatchConfig;
  private snapshot: NetPlayer[] = [];
  private signal: SignalState = "idle";
  private started = false;
  /** onStart fires once per session, when the server says "playing" */
  private announcedStart = false;
  private previewNoted = false;
  /** where our own body comes from while the arena runs */
  private stateProvider: (() => NetPlayerState) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** remote bodies currently handed to the arena, so each departure is reported once */
  private drawn = new Set<string>();
  /** counter for the remote states we hand on (the server already orders them) */
  private remoteSeq = 0;
  /** lobby-relevant fields last published, so onChange is not fired 20× a second */
  private rosterKey = "";
  /** our measured round trip to the server, ms */
  private rtt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** strictly increasing per page; the server drops anything it has seen */
  private shotSeq = 0;
  /** our own health as last handed to the arena, and who took the last of it */
  private healthKey = "";
  private killedBy: string | null = null;
  /** the rematch counter as last seen */
  private round: number | null = null;
  /** the server's winner ("" while undecided) */
  private winner = "";

  constructor(code: string, name: string, isHost: boolean, config: MatchConfig, deps: ColyseusSessionDeps = {}) {
    this.code = code.toUpperCase();
    this.name = name.trim().slice(0, NAME_MAX) || (isHost ? "HOST" : "GUEST");
    this.isHost = isHost;
    this.config = normalizeMatchConfig(config);
    this.url = deps.url !== undefined ? deps.url : readColyseusUrl(viteEnv());
    this.storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    this.resumeOnly = deps.resumeOnly ?? false;
    this.joinTimeoutMs = deps.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
  }

  setHandlers(patch: MatchHandlers) {
    Object.assign(this.handlers, patch);
    // State patches only carry changes, so a player standing still sends
    // none. The arena installs its body handler after the match has started:
    // hand it every body that is already there, or they stay invisible until
    // they move.
    if (patch.onRemoteState) {
      this.drawn.clear();
      this.sync();
    }
  }

  get joined(): boolean {
    return this.me !== "" && this.snapshot.some((p) => p.isMe);
  }

  /** The server decides the match (first to 15); the arena shows its verdict. */
  get winnerId(): string {
    return this.winner;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  connect() {
    if (this.started) return;
    this.started = true;
    void this.boot();
  }

  private async boot() {
    if (!this.url) {
      this.fail(
        "VITE_COLYSEUS_URL is not set, so this build has no match server to use. Set it, or build without VITE_NET_TRANSPORT=colyseus.",
      );
      return;
    }
    this.setSignal("connecting");
    const hint = globalThis.setTimeout(() => {
      if (this.phase === "connecting") this.handlers.onStatus?.(WAKE_HINT);
    }, WAKE_HINT_MS);
    this.joinTimer = globalThis.setTimeout(() => this.giveUp(), this.joinTimeoutMs);
    let sdk: typeof import("@colyseus/sdk");
    try {
      sdk = await loadSdk();
    } catch {
      globalThis.clearTimeout(hint);
      if (this.phase !== "closed") this.fail("Could not load the multiplayer code. Check your connection and press TRY AGAIN.");
      return;
    }
    const client = new sdk.Client(this.url);

    let room = await this.resumeSeat(client);
    if (!room && this.resumeOnly) {
      globalThis.clearTimeout(hint);
      if (this.phase !== "closed") this.fail(`Your seat in match ${this.code || "the match"} has expired. Create or join a match again.`);
      return;
    }
    // LEAVE, or the join timeout, while the seat was being tried: ask for nothing new.
    if (!room && this.phase === "closed") {
      globalThis.clearTimeout(hint);
      return;
    }
    room ??= await this.freshSeat(client);
    globalThis.clearTimeout(hint);
    if (!room) return;
    if (this.phase === "closed") {
      // LEAVE was pressed, or we gave up waiting, while still connecting.
      void leaveRoom(room).catch(() => {});
      return;
    }
    this.attach(room);
  }

  /** Connecting took longer than joinTimeoutMs: say so and offer TRY AGAIN. */
  private giveUp() {
    this.joinTimer = null;
    if (this.phase !== "connecting") return;
    const room = this.room;
    this.fail(JOIN_TIMEOUT_TEXT);
    // A room that answered but never sent us in: let the seat go too.
    if (room) {
      this.room = null;
      clearSeat(this.storage);
      void leaveRoom(room).catch(() => {});
    }
  }

  private clearJoinTimer() {
    if (this.joinTimer) globalThis.clearTimeout(this.joinTimer);
    this.joinTimer = null;
  }

  /** A reload: take this tab's held seat back with its token, if it is ours to take. */
  private async resumeSeat(client: Client): Promise<Room | null> {
    const seat = readSeat(this.storage, Date.now());
    if (!seat || seat.isHost !== this.isHost) return null;
    if (!this.isHost && seat.code !== this.code) return null;
    try {
      const room = await client.reconnect(seat.token);
      this.handlers.onStatus?.(this.isHost ? `REOPENED ROOM ${room.roomId}` : "BACK IN THE ROOM");
      return room;
    } catch {
      // Expired or never held: the seat is gone, so join like anyone else.
      clearSeat(this.storage);
      return null;
    }
  }

  private async freshSeat(client: Client): Promise<Room | null> {
    try {
      if (this.isHost) {
        return await client.create("match", { name: this.name, map: this.config.map, grapple: this.config.grapple });
      }
      return await client.joinById(this.code, { name: this.name });
    } catch (err) {
      if (this.phase !== "closed") this.fail(describeJoinError(err, this.code, this.url ?? ""));
      return null;
    }
  }

  /**
   * Diagnostics: one console line per connection event, for the next time a
   * match is lost. Session id and room code only; never the reconnection token
   * or a player's name. Not every event has a code: the socket's `error` event
   * carries none (browsers hide why a WebSocket failed), and is logged as such.
   */
  private logConnection(room: Room, event: string, code?: number, reason?: string) {
    const r = room.reconnection;
    // one JSON string, so it reads the same in devtools and in a test's captured console
    const details = JSON.stringify({
      code: code ?? "(none exposed)",
      meaning: code === undefined ? undefined : (CLOSE_CODES[code] ?? "unlisted"),
      reason: reason || "(none)",
      session: room.sessionId,
      phase: this.phase,
      signal: this.signal,
      reconnecting: r?.isReconnecting ?? false,
      reconnectAttempts: r ? `${r.retryCount}/${r.maxRetries}` : "n/a",
      dropsSinceJoin: this.drops,
      msSinceJoin: Math.round(Date.now() - this.attachedAt),
      msSinceLastDrop: this.lastDropAt ? Math.round(Date.now() - this.lastDropAt) : null,
      online: typeof navigator === "undefined" ? undefined : navigator.onLine,
    });
    console.warn(`[colyseus ${this.code}] ${event} ${details}`);
  }

  private attach(room: Room) {
    this.room = room;
    this.me = room.sessionId;
    this.code = room.roomId;
    this.attachedAt = Date.now();
    this.rememberSeat();

    room.onStateChange(() => this.sync());
    room.onDrop((code, reason) => {
      this.drops++;
      this.lastDropAt = Date.now();
      // the SDK calls this as it starts its own reconnection attempts
      this.logConnection(room, "dropped; SDK reconnecting", code, reason);
      this.setSignal("retrying", "connection dropped — reconnecting");
      this.handlers.onStatus?.("CONNECTION DROPPED — RECONNECTING…");
    });
    room.onReconnect(() => {
      this.logConnection(room, "reconnected");
      this.rememberSeat();
      this.setSignal("open");
      this.handlers.onStatus?.("RECONNECTED");
    });
    room.onLeave((code, reason) => {
      this.logConnection(room, this.phase === "closed" ? "left (we closed it)" : "left; match lost", code, reason);
      if (this.phase === "closed") return;
      if (code === SERVER_SHUTDOWN) {
        // a redeploy or restart: every room on the server has gone with it
        clearSeat(this.storage);
        this.fail(RESTARTED_TEXT);
        return;
      }
      // The seat is kept: the server may still be holding it, and joining
      // again from this tab tries the token first (a dead one is then cleared).
      this.fail("Lost the connection to the match server and could not get back in. Join again.");
    });
    // The server says it is shutting down. Its close (SERVER_SHUTDOWN) may never
    // arrive (the Render deployment loses closes the server starts), so treat
    // the notice as the close: end the match here and close from this side.
    room.onMessage(SERVER_CLOSING_MESSAGE, () => {
      if (this.phase === "closed") return;
      this.logConnection(room, "server shutting down (told by message)");
      clearSeat(this.storage);
      this.room = null;
      this.fail(RESTARTED_TEXT);
      void leaveRoom(room).catch(() => {});
    });
    room.onError((code, message) => this.logConnection(room, "error", code, message));
    room.onMessage("hit", (e: HitEvent) => this.onHitEvent(e));
    room.onMessage("eliminated", (e: EliminatedEvent) => this.onEliminated(e));
    const ping = () => room.ping((ms) => (this.rtt = ms));
    ping();
    this.pingTimer = setInterval(ping, PING_EVERY_MS);

    this.setSignal("open");
    this.handlers.onStatus?.(this.isHost ? "ROOM OPEN — SEND THE CODE" : "IN THE ROOM — READY WHEN YOU ARE");
    this.sync();
  }

  private rememberSeat() {
    if (!this.room) return;
    writeSeat(this.storage, {
      code: this.room.roomId,
      token: this.room.reconnectionToken,
      isHost: this.isHost,
      createdAt: Date.now(),
    });
  }

  close() {
    this.clearJoinTimer();
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.stopTicking();
    this.stopPinging();
    // Leaving on purpose gives the seat up at once, and this tab forgets it.
    clearSeat(this.storage);
    const room = this.room;
    this.room = null;
    if (room) void leaveRoom(room).catch(() => {});
    this.setSignal("closed");
  }

  /** Visibility changes are not room lifecycles; the SDK reconnects on its own. */
  resume() {}

  /**
   * A real unload. Nothing to send: the socket closes with the page, and the
   * server holds the seat. Stamping the time lets the next load of this tab
   * know whether that hold is still running (see resumableSeat).
   */
  suspend() {
    const seat = readSeat(this.storage, Date.now());
    if (seat && this.room && seat.token === this.room.reconnectionToken) {
      writeSeat(this.storage, { ...seat, leftAt: Date.now() });
    }
  }

  private stopPinging() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private fail(text: string) {
    this.clearJoinTimer();
    this.phase = "closed";
    this.stopTicking();
    this.stopPinging();
    this.setSignal("lost", text);
    this.handlers.onError?.(text);
    this.handlers.onLost?.(text);
  }

  private setSignal(state: SignalState, detail?: string) {
    this.signal = state;
    this.handlers.onSignal?.(state, detail);
  }

  /* --------------------------------- state --------------------------------- */

  /** Mirror the server's state into the roster rows and callbacks the lobby uses. */
  private sync() {
    const room = this.room;
    if (!room?.state) return;
    const s = (room.state as { toJSON(): RoomJSON }).toJSON();

    const config = normalizeMatchConfig({ map: s.map, grapple: s.grapple });
    if (config.map !== this.config.map || config.grapple !== this.config.grapple) {
      this.config = config;
      this.handlers.onConfig?.(config);
    }

    const players = Object.values(s.players ?? {});
    this.snapshot = players
      .map(
        (p): NetPlayer => ({
          id: p.id,
          name: p.name,
          ink: p.ink,
          isMe: p.id === this.me,
          isHost: p.isHost,
          kills: p.kills ?? 0,
          deaths: p.deaths ?? 0,
          state: p.spawned ? this.bodyOf(p) : { ...IDLE },
          online: p.connected,
          ready: p.isHost || p.ready,
        }),
      )
      .sort((a, b) => Number(b.isHost) - Number(a.isHost));
    this.syncBodies(players);

    if (this.phase !== "closed") this.clearJoinTimer();
    if (s.phase === "playing") {
      this.phase = "playing";
      if (!this.announcedStart) {
        this.announcedStart = true;
        this.handlers.onStart?.(this.config);
      }
    } else if (this.phase !== "closed") {
      this.phase = "lobby";
    }
    // A host rematch: every client restarts the round from the same moment.
    const round = s.round ?? 0;
    if (this.round !== null && round > this.round && this.phase === "playing") {
      this.killedBy = null;
      this.handlers.onRematch?.();
    }
    this.round = round;
    this.winner = s.winnerId ?? "";
    this.syncHealth(players.find((p) => p.id === this.me));
    // Bodies change every patch; the roster, the score and the result rarely do. Re-render only for those.
    const key = JSON.stringify([
      this.winner,
      this.snapshot.map((p) => [p.id, p.name, p.ink, p.isHost, p.ready, p.online, p.kills, p.deaths]),
    ]);
    if (key !== this.rosterKey) {
      this.rosterKey = key;
      this.handlers.onChange?.();
    }
  }

  /** A server-held body in the shape the engine draws. */
  private bodyOf(p: PlayerJSON): NetPlayerState {
    return {
      x: p.x ?? 0,
      y: p.y ?? 0,
      z: p.z ?? 0,
      yaw: p.yaw ?? 0,
      pitch: p.pitch ?? 0,
      hp: p.hp ?? IDLE.hp,
      alive: p.alive ?? false,
      moving: p.moving ?? false,
      // cosmetic (muzzle puffs, the swing); what a shot did is the server's call
      firing: p.firing ?? false,
      weapon: p.weapon ?? IDLE.weapon,
      epoch: p.epoch ?? 0,
      seq: ++this.remoteSeq,
    };
  }

  /**
   * Hand every other connected, placed body to the arena, and report each one
   * that stopped being drawable (left, dropped, not placed yet) exactly once.
   */
  private syncBodies(players: PlayerJSON[]) {
    const visible = new Set<string>();
    if (this.phase === "playing") {
      for (const p of players) {
        if (p.id === this.me || !p.connected || !p.spawned) continue;
        visible.add(p.id);
        this.drawn.add(p.id);
        this.handlers.onRemoteState?.(p.id, this.bodyOf(p));
      }
    }
    for (const id of [...this.drawn]) {
      if (visible.has(id)) continue;
      this.drawn.delete(id);
      this.handlers.onPeerGone?.(id);
    }
  }

  getPlayers(): NetPlayer[] {
    return this.snapshot;
  }

  getConfig(): MatchConfig {
    return this.config;
  }

  /* -------------------------------- actions -------------------------------- */

  /** Host only; the server ignores anyone else, and anything after the start. */
  setConfig(patch: Partial<MatchConfig>) {
    if (!this.room || !this.isHostNow()) return;
    const next = normalizeMatchConfig({ ...this.config, ...patch });
    this.room.send("config", { map: next.map, grapple: next.grapple });
  }

  setReady(ready: boolean) {
    if (!this.room || !this.joined || this.isHostNow()) return;
    this.room.send("ready", { ready });
  }

  /** Ask the server to start. It decides; the lobby moves when the state says "playing". */
  beginMatch() {
    const room = this.room;
    if (!room) return;
    room
      .request("start")
      .then((result: StartResult) => {
        if (!result.ok) this.handlers.onError?.(START_REFUSALS[result.reason] ?? "The server refused to start the match.");
      })
      .catch(() => this.handlers.onError?.("Could not reach the match server to start the match."));
  }

  /** The server can promote a guest when the host leaves for good. */
  private isHostNow(): boolean {
    return this.snapshot.some((p) => p.isMe && p.isHost);
  }

  /* -------------------------------- arena -------------------------------- */

  setStateProvider(fn: (() => NetPlayerState) | null) {
    this.stateProvider = fn;
  }

  /** Send our body MOVE_RATE_HZ times a second while the match runs. */
  startTicking() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 1000 / MOVE_RATE_HZ);
    if (this.previewNoted) return;
    this.previewNoted = true;
    // Deferred so it lands after the arena has installed its feed handler.
    globalThis.setTimeout(() => this.handlers.onFeed?.("COLYSEUS PREVIEW — THE MATCH SERVER REFEREES EVERY SHOT", true), 0);
  }

  private stopTicking() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private tick() {
    const room = this.room;
    if (!room || this.phase !== "playing" || !this.stateProvider) return;
    const s = this.stateProvider();
    // The server disconnects a client that sends a non-finite number; a
    // broken frame is skipped instead.
    if (![s.x, s.y, s.z, s.yaw, s.pitch, s.epoch].every(Number.isFinite)) return;
    room.send("move", {
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      pitch: s.pitch,
      moving: s.moving,
      firing: s.firing,
      alive: s.alive,
      weapon: s.weapon,
      epoch: s.epoch,
    });
  }

  /* --------------------------------- combat --------------------------------- */

  /** Hand an attack to the server, stamped with a shot id and how old our view is. */
  reportCombat(i: NetCombatIntent) {
    const room = this.room;
    if (!room || this.phase !== "playing") return;
    const ok = (v: NetShotOrigin) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    // The server disconnects a client that sends a non-finite number.
    if ("origin" in i && (!ok(i.origin) || !ok(i.dir))) return;
    const lag = Math.max(0, Math.min(5000, Math.round(this.rtt + VIEW_DELAY_MS)));
    switch (i.kind) {
      case "fire":
        room.send("fire", { shot: ++this.shotSeq, weapon: i.weapon, origin: i.origin, dir: i.dir, ads: i.ads, air: i.air, lag });
        break;
      case "slash":
      case "dash":
        room.send(i.kind, { shot: ++this.shotSeq, origin: i.origin, dir: i.dir, lag });
        break;
      case "throw":
        room.send("throw", { shot: ++this.shotSeq, origin: i.origin, dir: i.dir });
        break;
      case "reload":
        room.send("reload", { weapon: i.weapon });
        break;
      case "hazard":
        if (Number.isFinite(i.damage)) room.send("hazard", { damage: i.damage });
        break;
    }
  }

  private onHitEvent(e: HitEvent) {
    if (e.victim === this.me) {
      if (e.kill) this.killedBy = e.attacker === this.me ? null : e.attacker;
      this.handlers.onHurt?.(e.damage, e.attacker === this.me ? null : e.attacker);
    } else if (e.attacker === this.me) {
      this.handlers.onShotLanded?.({ x: e.x, y: e.y, z: e.z, head: e.head, kill: e.kill, focus: e.weapon === "KATANA" });
    }
  }

  /** The kill feed. Our own obituary is written by the arena when we fall. */
  private onEliminated(e: EliminatedEvent) {
    if (e.victim === this.me) {
      this.killedBy = e.killer || null;
      return;
    }
    const name = (id: string) => this.snapshot.find((p) => p.id === id)?.name ?? "SOMEONE";
    const text = e.killer ? `${name(e.killer)} ERASED ${name(e.victim)}` : `${name(e.victim)} ERASED THEMSELVES`;
    this.handlers.onFeed?.(text, e.killer === this.me);
  }

  /** Our health as the server has it; the arena corrects its own copy to match. */
  private syncHealth(me: PlayerJSON | undefined) {
    if (!me || this.phase !== "playing" || !me.spawned) return;
    const hp = me.hp ?? IDLE.hp;
    const alive = me.alive ?? false;
    const key = `${hp}|${alive}`;
    if (key === this.healthKey) return;
    this.healthKey = key;
    if (alive) this.killedBy = null;
    this.handlers.onHealth?.(hp, alive, this.killedBy);
  }

  // The server keeps the score and decides deaths and respawns; these PeerJS
  // reports have nothing to do here.
  reportHit() {}
  reportDeath() {}
  reportRespawn() {}

  /** Host only: the server resets the round for everyone (see onRematch in sync()). */
  rematch() {
    if (!this.room || !this.isHostNow()) return;
    this.room.send("rematch");
  }

  diagnostics() {
    return {
      transport: "colyseus",
      server: this.url,
      code: this.code,
      role: this.isHost ? "host" : "guest",
      signaling: this.signal,
      joined: this.joined,
      players: this.snapshot.length,
    };
  }
}
