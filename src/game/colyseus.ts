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
// draws remote players exactly as it does over WebRTC. Combat is not
// synchronized yet: hits, deaths, respawns and rematches are still no-ops.
//
// Reloads: the server holds a dropped seat for a short window, and only the
// holder of that seat's reconnection token can take it back. The token is kept
// in sessionStorage (one tab, one seat) and used before any fresh join, so a
// reload resumes the same seat instead of adding a second one.

import type { Client, Room } from "@colyseus/sdk";
import { normalizeMatchConfig, type MatchConfig } from "./maps";
import type { NetHandlers, NetPlayer, SignalState } from "./net";
import type { NetPlayerState } from "./types";
import { readColyseusUrl, viteEnv, type MatchSession } from "./transport";

/** sessionStorage key for this tab's seat; separate from the PeerJS lease. */
export const SEAT_KEY = "dd_colyseus_seat";
/** A stored seat older than this is not worth a reconnection attempt. */
const SEAT_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * How long after the page unloads its seat is still held: the server's
 * RECONNECT_SECONDS (server/src/rules.ts), less a little for the round trip.
 */
export const RESUME_WINDOW_MS = 28_000;

/** How often our body is sent (Hz); the server patches at the same rate. */
export const MOVE_RATE_HZ = 20;

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
  alive?: boolean;
  weapon?: string;
  epoch?: number;
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
  hp: 120, alive: false, moving: false, firing: false, weapon: "RIFLE",
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
 * The lobby cannot rely on the URL for this. Convex Auth consumes any `?code=`
 * query parameter on load (it is its OAuth callback name), so a guest's invite
 * link has lost its room code by the time the page is reloaded.
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
};

export class ColyseusSession implements MatchSession {
  /** the room code; empty for a host until the server has made the room */
  code: string;
  readonly isHost: boolean;
  name: string;
  me = "";
  phase: "connecting" | "lobby" | "playing" | "closed" = "connecting";
  readonly rewindMs = 0;

  private readonly url: string | null;
  private readonly storage: SeatStorage | null;
  private readonly resumeOnly: boolean;
  private handlers: NetHandlers = {};
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

  constructor(code: string, name: string, isHost: boolean, config: MatchConfig, deps: ColyseusSessionDeps = {}) {
    this.code = code.toUpperCase();
    this.name = name.trim().slice(0, 16) || (isHost ? "HOST" : "GUEST");
    this.isHost = isHost;
    this.config = normalizeMatchConfig(config);
    this.url = deps.url !== undefined ? deps.url : readColyseusUrl(viteEnv());
    this.storage = deps.storage !== undefined ? deps.storage : defaultStorage();
    this.resumeOnly = deps.resumeOnly ?? false;
  }

  setHandlers(patch: NetHandlers) {
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
    // Loaded on demand: a PeerJS build (the default) never downloads the SDK.
    const { Client } = await import("@colyseus/sdk");
    const client = new Client(this.url);

    let room = await this.resumeSeat(client);
    if (!room && this.resumeOnly) {
      this.fail(`Your seat in match ${this.code || "the match"} has expired. Create or join a match again.`);
      return;
    }
    room ??= await this.freshSeat(client);
    if (!room) return;
    if (this.phase === "closed") {
      // LEAVE was pressed while we were still connecting.
      void room.leave(true).catch(() => {});
      return;
    }
    this.attach(room);
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

  private attach(room: Room) {
    this.room = room;
    this.me = room.sessionId;
    this.code = room.roomId;
    this.rememberSeat();

    room.onStateChange(() => this.sync());
    room.onDrop(() => {
      this.setSignal("retrying", "connection dropped — reconnecting");
      this.handlers.onStatus?.("CONNECTION DROPPED — RECONNECTING…");
    });
    room.onReconnect(() => {
      this.rememberSeat();
      this.setSignal("open");
      this.handlers.onStatus?.("RECONNECTED");
    });
    room.onLeave(() => {
      if (this.phase === "closed") return;
      // The seat is kept: the server may still be holding it, and joining
      // again from this tab tries the token first (a dead one is then cleared).
      this.fail("Lost the connection to the match server and could not get back in. Join again.");
    });
    room.onError((code, message) => console.warn(`[colyseus ${this.code}] error ${code}`, message ?? ""));

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
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.stopTicking();
    // Leaving on purpose gives the seat up at once, and this tab forgets it.
    clearSeat(this.storage);
    const room = this.room;
    this.room = null;
    if (room) void room.leave(true).catch(() => {});
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

  private fail(text: string) {
    this.phase = "closed";
    this.stopTicking();
    this.setSignal("lost", text);
    this.handlers.onError?.(text);
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
          kills: 0,
          deaths: 0,
          state: p.spawned ? this.bodyOf(p) : { ...IDLE },
          online: p.connected,
          ready: p.isHost || p.ready,
        }),
      )
      .sort((a, b) => Number(b.isHost) - Number(a.isHost));
    this.syncBodies(players);

    if (s.phase === "playing") {
      this.phase = "playing";
      if (!this.announcedStart) {
        this.announcedStart = true;
        this.handlers.onStart?.(this.config);
      }
    } else if (this.phase !== "closed") {
      this.phase = "lobby";
    }
    // Bodies change every patch; the roster rarely does. Re-render only for the latter.
    const key = JSON.stringify(this.snapshot.map((p) => [p.id, p.name, p.ink, p.isHost, p.ready, p.online]));
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
      // Health is not synchronized yet; a standing body reads as full.
      hp: IDLE.hp,
      alive: p.alive ?? false,
      moving: p.moving ?? false,
      firing: false,
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
    globalThis.setTimeout(() => this.handlers.onFeed?.("COLYSEUS PREVIEW — MOVEMENT ONLY, COMBAT IS NOT SYNCED YET", true), 0);
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
      alive: s.alive,
      weapon: s.weapon,
      epoch: s.epoch,
    });
  }

  /* -------------------------- combat (next milestone) -------------------------- */

  reportHit() {}
  reportDeath() {}
  reportRespawn() {}
  rematch() {}

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
