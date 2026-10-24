import { Room, ServerError, validate, type AuthContext, type Client } from "colyseus";
import { z } from "zod";
import { MatchState, Player } from "./schema/MatchState.js";
import {
  drawRoomCode,
  freeInk,
  MAP_IDS,
  normalizeMatchOptions,
  RECONNECT_SECONDS,
  sanitizeName,
  type MapId,
} from "../rules.js";
import { isOriginAllowed, originPolicy } from "../origins.js";
import { isCreateRequest, REFUSAL_TEXT, RoomCreationLimiter, roomLimitsFromEnv } from "../limits.js";
import { Combat, type EliminatedEvent, type HitEvent } from "./Combat.js";
import {
  clampPitch,
  COORD_LIMIT,
  ENVELOPES,
  newMotion,
  PATCH_INTERVAL_MS,
  stepMotion,
  WEAPONS,
  wrapAngle,
  type Motion,
} from "../movement.js";

const coord = z.number().min(-COORD_LIMIT).max(COORD_LIMIT);
const angle = z.number().min(-1000).max(1000);

/**
 * client → server, ~MOVE_RATE_HZ while playing: where the client's engine says
 * its body is. Shape and magnitudes are checked here (a payload that fails is
 * a broken or hostile client, and is disconnected); bounds, speed and
 * teleports are decided by stepMotion().
 */
const moveMessage = z.object({
  x: coord,
  y: coord,
  z: coord,
  yaw: angle,
  pitch: angle,
  moving: z.boolean(),
  /** cosmetic: draws muzzle puffs on this body for everyone else (damage is never taken from it) */
  firing: z.boolean().optional(),
  alive: z.boolean(),
  weapon: z.string().max(16),
  /** the client's own body generation; a change asks for a teleport */
  epoch: z.number().int().min(0).max(2 ** 31 - 1),
});
type MoveMessage = z.infer<typeof moveMessage>;

const vec = z.object({ x: coord, y: coord, z: coord });
/** per-client counter, strictly increasing; a repeat is a duplicate and is dropped */
const shotId = z.number().int().min(1).max(2 ** 31 - 1);
/** how old the bodies the client aimed at were, ms (clamped to MAX_REWIND_MS) */
const lag = z.number().int().min(0).max(5000);
const weaponName = z.string().max(16);

/**
 * Combat intents (src/rooms/Combat.ts decides what they do). A payload of the
 * wrong shape disconnects the sender, as for `move`; a well-formed intent the
 * rules refuse (too fast, dead, unknown weapon, …) is dropped silently.
 */
const fireMessage = z.object({ shot: shotId, weapon: weaponName, origin: vec, dir: vec, ads: z.boolean(), air: z.boolean(), lag });
const meleeMessage = z.object({ shot: shotId, origin: vec, dir: vec, lag });
const throwMessage = z.object({ shot: shotId, origin: vec, dir: vec });
const reloadMessage = z.object({ weapon: weaponName });
const hazardMessage = z.object({ damage: z.number().min(0).max(1000) });

/**
 * Codes held by live rooms in this process. A room's code is its roomId, so
 * guests join with `client.joinById(code)`. This registry only spans one
 * process: running more than one needs a shared presence (Redis) instead.
 */
const liveCodes = new Set<string>();
const MAX_CODE_DRAWS = 64;

function reserveCode(): string {
  for (let i = 0; i < MAX_CODE_DRAWS; i++) {
    const code = drawRoomCode();
    if (!liveCodes.has(code)) {
      liveCodes.add(code);
      return code;
    }
  }
  throw new Error("could not allocate a free room code");
}

/** Why the server refused to start a match; the lobby turns these into text. */
export type StartRefusal = "not-host" | "not-in-lobby" | "no-guests" | "guests-not-ready" | "guest-reconnecting";
export type StartResult = { ok: true } | { ok: false; reason: StartRefusal };

/** HTTP-style status for a matchmaking request from a disallowed origin. */
const FORBIDDEN = 403;
/** HTTP-style status for a create refused by the room-creation limits. */
const TOO_MANY_REQUESTS = 429;

/**
 * Room-creation limits for this process (src/limits.ts), from MAX_ROOMS,
 * ROOM_CREATES_PER_MINUTE and ROOM_CREATES_PER_IP_PER_MINUTE.
 */
export const roomLimiter = new RoomCreationLimiter(roomLimitsFromEnv.limits);

/**
 * One Doodle Shooter match.
 *
 * The server owns the roster, the player limit, the ready flags, the match
 * rules and the decision to start. While playing it also holds every body's
 * position, facing and movement state, within the limits in movement.ts, and
 * runs all combat (Combat.ts): clients send intent, the server decides hits,
 * damage, health, deaths, respawns, scores and the winner.
 *
 * Identity is the Colyseus session: a player who drops keeps their seat for
 * RECONNECT_SECONDS, and only the holder of that seat's reconnection token can
 * take it back. A fresh join always gets a fresh seat, never someone else's.
 */
export class MatchRoom extends Room<{ state: MatchState }> {
  state = new MatchState();
  /** a slow or hostile client cannot flood the room */
  maxMessagesPerSecond = 60;
  /** how long a dropped player's seat is held; tests shorten it */
  reconnectSeconds = RECONNECT_SECONDS;
  /** per-player movement limiter; server-only, keyed by session id */
  private motion = new Map<string, Motion>();
  /** health, deaths and scores; public so tests can read its counters */
  combat = new Combat(this.state, (type: "hit" | "eliminated", message: HitEvent | EliminatedEvent) =>
    this.broadcast(type, message),
  );

  /**
   * Matchmaking gate: refuse browsers on origins that are not allowed. The
   * WebSocket upgrade is checked separately (see app.config.ts), so a
   * reconnection, which skips matchmaking auth, is covered too.
   */
  static async onAuth(_token: string, _options: unknown, context: AuthContext) {
    if (!isOriginAllowed(context.headers.get("origin"), originPolicy)) {
      throw new ServerError(FORBIDDEN, "origin not allowed");
    }
    if (isCreateRequest(context.req)) {
      const refusal = roomLimiter.tryCreate(context.ip, liveCodes.size);
      if (refusal) {
        // no address in the log: the reason and the room count are enough to see an abuse pattern
        console.warn(JSON.stringify({ event: "create-refused", reason: refusal, liveRooms: liveCodes.size }));
        throw new ServerError(TOO_MANY_REQUESTS, REFUSAL_TEXT[refusal]);
      }
    }
    return true;
  }

  messages = {
    /** guest → server: lobby ready flag (the host is always ready) */
    ready: validate(z.object({ ready: z.boolean() }), (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || player.isHost || this.state.phase !== "lobby") return;
      player.ready = message.ready;
    }),
    /** host → server: change the map or grapple rule while in the lobby */
    config: validate(
      z.object({ map: z.enum(MAP_IDS).optional(), grapple: z.boolean().optional() }),
      (client, message) => {
        if (client.sessionId !== this.state.hostId || this.state.phase !== "lobby") return;
        if (message.map !== undefined) this.state.map = message.map;
        if (message.grapple !== undefined) this.state.grapple = message.grapple;
      },
    ),
    /**
     * host → server: begin the match. Answered (use `room.request("start")`)
     * so the lobby can say why a start was refused.
     */
    start: (client: Client): StartResult => {
      const refusal = this.startRefusal(client.sessionId);
      if (refusal) return { ok: false, reason: refusal };
      // Every body starts unplaced: each client's first move is its spawn.
      for (const p of this.state.players.values()) p.spawned = false;
      this.motion.clear();
      this.state.phase = "playing";
      this.combat.resetMatch();
      return { ok: true };
    },
    move: validate(moveMessage, (client, message) => this.applyMove(client.sessionId, message)),
    fire: validate(fireMessage, (client, m) => this.combat.fire(client.sessionId, m)),
    slash: validate(meleeMessage, (client, m) => this.combat.slash(client.sessionId, m)),
    dash: validate(meleeMessage, (client, m) => this.combat.dash(client.sessionId, m)),
    throw: validate(throwMessage, (client, m) => this.combat.throwGrenade(client.sessionId, m)),
    reload: validate(reloadMessage, (client, m) => this.combat.reload(client.sessionId, m.weapon)),
    hazard: validate(hazardMessage, (client, m) => this.combat.hazard(client.sessionId, m.damage)),
    /** host → server: run the match again (scores, health and the winner reset) */
    rematch: (client: Client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== "playing") return;
      this.combat.resetMatch();
      this.state.round += 1;
    },
  };

  /** Accept a client's proposed body, within the map's volume and the movement limits. */
  private applyMove(sessionId: string, m: MoveMessage) {
    if (this.state.phase !== "playing") return;
    const p = this.state.players.get(sessionId);
    if (!p || !p.connected) return;
    const now = Date.now();
    let motion = this.motion.get(sessionId);
    if (!motion) {
      motion = newMotion(now);
      this.motion.set(sessionId, motion);
    }
    const wantsTeleport = motion.clientEpoch === null || m.epoch !== motion.clientEpoch;
    const result = stepMotion(
      motion,
      p.spawned ? { x: p.x, y: p.y, z: p.z } : null,
      { x: m.x, y: m.y, z: m.z },
      wantsTeleport,
      now,
      ENVELOPES[this.state.map as MapId],
    );
    // A refused teleport keeps the old epoch on file, so the next packet asks
    // again; meanwhile the body walks toward the claim at the speed limit.
    if (result.teleported) {
      motion.clientEpoch = m.epoch;
      p.epoch += 1;
    }
    p.x = result.pos.x;
    p.y = result.pos.y;
    p.z = result.pos.z;
    p.yaw = wrapAngle(m.yaw);
    p.pitch = clampPitch(m.pitch);
    p.moving = m.moving;
    p.firing = m.firing === true;
    // `alive` is the server's now (combat decides it); the client's report is ignored.
    if ((WEAPONS as readonly string[]).includes(m.weapon)) p.weapon = m.weapon;
    p.spawned = true;
    this.combat.moved(p, result.teleported, p.weapon);
  }

  /** The same rules the lobby's ENTER ARENA button shows, enforced here. */
  private startRefusal(sessionId: string): StartRefusal | null {
    if (sessionId !== this.state.hostId) return "not-host";
    if (this.state.phase !== "lobby") return "not-in-lobby";
    const guests = [...this.state.players.values()].filter((p) => !p.isHost);
    if (guests.length === 0) return "no-guests";
    if (guests.some((p) => !p.connected)) return "guest-reconnecting";
    if (guests.some((p) => !p.ready)) return "guests-not-ready";
    return null;
  }

  onCreate(options: unknown) {
    const opts = normalizeMatchOptions(options);
    this.roomId = reserveCode();
    // Only `joinById` (the code) gets anyone in; private rooms are also invisible
    // to `join`/`joinOrCreate`, which app.config.ts does not expose anyway.
    void this.setPrivate(true);
    this.maxClients = opts.maxPlayers;
    this.state.code = this.roomId;
    this.state.map = opts.map;
    this.state.grapple = opts.grapple;
    this.state.maxPlayers = opts.maxPlayers;
    this.setPatchRate(PATCH_INTERVAL_MS);
    // regen, grenade fuses and late respawns
    this.setSimulationInterval(() => this.combat.tick(), PATCH_INTERVAL_MS);
  }

  onJoin(client: Client, options: unknown) {
    const isHost = this.state.players.size === 0;
    const raw = options && typeof options === "object" ? (options as { name?: unknown }).name : undefined;
    const used = [...this.state.players.values()].map((p) => p.ink);
    const player = new Player();
    player.id = client.sessionId;
    player.name = sanitizeName(raw, isHost ? "HOST" : "GUEST");
    player.ink = freeInk(used);
    player.isHost = isHost;
    player.ready = isHost;
    this.state.players.set(client.sessionId, player);
    if (isHost) this.state.hostId = client.sessionId;
    this.combat.joined(player);
  }

  /**
   * Lost without saying goodbye (closed tab, reload, network): hold the seat.
   *
   * Every non-consented close lands here, including the one Colyseus itself
   * makes when the seat's owner reconnects with its token while the old socket
   * still looks alive: it closes the stale socket and expects this hold to let
   * the new one in. A client kicked for a malformed message is held the same
   * way; only its own token can bring it back, and the hold expires.
   */
  onDrop(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = false;
    this.allowReconnection(client, this.reconnectSeconds).catch(() => {
      // Refused while the room is being disposed (a server shutdown closes
      // every client): there is no seat left to hold. An expired hold also
      // rejects; Colyseus handles that itself and calls onLeave.
    });
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
    // A reloaded page runs a fresh engine whose epochs restart; its first move
    // is a re-spawn, not a step.
    const motion = this.motion.get(client.sessionId);
    if (motion) motion.clientEpoch = null;
    this.combat.reconnected(client.sessionId);
  }

  /** Gone for good: left on purpose, or the reconnection window ran out. */
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.motion.delete(client.sessionId);
    this.combat.forget(client.sessionId);
    if (client.sessionId !== this.state.hostId) return;
    // The roster lives on the server, so the room outlives its host: the
    // longest-standing connected guest takes over and is ready by definition.
    const players = [...this.state.players.values()];
    const next = players.find((p) => p.connected) ?? players[0];
    this.state.hostId = next?.id ?? "";
    if (next) {
      next.isHost = true;
      next.ready = true;
    }
  }

  onDispose() {
    liveCodes.delete(this.roomId);
  }
}
