import { Room, ServerError, validate, type AuthContext, type Client } from "colyseus";
import { z } from "zod";
import { MatchState, Player } from "./schema/MatchState.js";
import { drawRoomCode, freeInk, MAP_IDS, normalizeMatchOptions, RECONNECT_SECONDS, sanitizeName } from "../rules.js";
import { isOriginAllowed, originPolicy } from "../origins.js";

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

/**
 * One Doodle Shooter match.
 *
 * The server owns the roster, the player limit, the ready flags, the match
 * rules and the decision to start. Gameplay traffic (transforms, hits, deaths,
 * respawns) still runs over PeerJS for now.
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

  /**
   * Matchmaking gate: refuse browsers on origins that are not allowed. The
   * WebSocket upgrade is checked separately (see app.config.ts), so a
   * reconnection, which skips matchmaking auth, is covered too.
   */
  static async onAuth(_token: string, _options: unknown, context: AuthContext) {
    if (!isOriginAllowed(context.headers.get("origin"), originPolicy)) {
      throw new ServerError(FORBIDDEN, "origin not allowed");
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
      this.state.phase = "playing";
      return { ok: true };
    },
  };

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
    this.maxClients = opts.maxPlayers;
    this.state.code = this.roomId;
    this.state.map = opts.map;
    this.state.grapple = opts.grapple;
    this.state.maxPlayers = opts.maxPlayers;
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
    this.allowReconnection(client, this.reconnectSeconds);
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
  }

  /** Gone for good: left on purpose, or the reconnection window ran out. */
  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
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
