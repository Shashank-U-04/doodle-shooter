import { Room, validate, type Client } from "colyseus";
import { z } from "zod";
import { MatchState, Player } from "./schema/MatchState.js";
import { drawRoomCode, freeInk, MAP_IDS, normalizeMatchOptions, sanitizeName } from "../rules.js";

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

/**
 * One Doodle Shooter match.
 *
 * First slice of the Colyseus migration: the server owns the roster, the
 * player limit, the ready flags and the match rules. Gameplay traffic
 * (transforms, hits, deaths, respawns) still runs over PeerJS for now.
 */
export class MatchRoom extends Room<{ state: MatchState }> {
  state = new MatchState();
  /** a slow or hostile client cannot flood the room */
  maxMessagesPerSecond = 60;

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
  };

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

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    if (client.sessionId !== this.state.hostId) return;
    // The roster lives on the server now, so the room outlives its host: the
    // longest-standing guest takes over and is ready by definition.
    const next = this.state.players.values().next().value;
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
