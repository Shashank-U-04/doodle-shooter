import { schema, t, type SchemaType } from "@colyseus/schema";

/** One player as every client in the room sees them. Owned by the server. */
export const Player = schema({
  /** the Colyseus session id; also the key in MatchState.players */
  id: t.string(),
  name: t.string(),
  /** ink palette index (0-5), unique within the room */
  ink: t.uint8(),
  isHost: t.boolean().default(false),
  /** lobby ready flag; the host is always ready */
  ready: t.boolean().default(false),
  /** false while the seat is held for a reconnection */
  connected: t.boolean().default(true),

  // ---- body, while playing (server-validated; see src/movement.ts) ----
  /** the body has a server-accepted position; nothing to draw until then */
  spawned: t.boolean().default(false),
  x: t.float32().default(0),
  y: t.float32().default(0),
  z: t.float32().default(0),
  /** facing, radians in (−π, π] */
  yaw: t.float32().default(0),
  /** look angle, radians in [−π/2, π/2] */
  pitch: t.float32().default(0),
  moving: t.boolean().default(false),
  /** a weapon is going off (drawn as muzzle puffs / a swing); cosmetic, client-reported */
  firing: t.boolean().default(false),
  /** standing; the server's call (it applies all damage) */
  alive: t.boolean().default(false),
  weapon: t.string().default("RIFLE"),
  /** bumped by the server each time it accepts a teleport; viewers snap on a change */
  epoch: t.uint32().default(0),

  // ---- combat (server-authoritative; see src/combat.ts) ----
  hp: t.float32().default(120),
  kills: t.uint16().default(0),
  deaths: t.uint16().default(0),
});
export type Player = SchemaType<typeof Player>;

export const MatchState = schema({
  /** the room code players type to join; equal to the Colyseus roomId */
  code: t.string(),
  /** "lobby" until the host starts, then "playing" */
  phase: t.string().default("lobby"),
  map: t.string(),
  grapple: t.boolean().default(true),
  maxPlayers: t.uint8(),
  hostId: t.string().default(""),
  /** set when someone reaches the winning score; combat stops until a rematch */
  winnerId: t.string().default(""),
  /** bumped by each host rematch; clients restart the round when it changes */
  round: t.uint16().default(0),
  players: t.map(Player),
});
export type MatchState = SchemaType<typeof MatchState>;
