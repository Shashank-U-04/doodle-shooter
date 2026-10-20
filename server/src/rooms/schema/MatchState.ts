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
  players: t.map(Player),
});
export type MatchState = SchemaType<typeof MatchState>;
