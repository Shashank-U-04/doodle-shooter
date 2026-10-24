// Rules the browser and the match server must agree on: room limits, room
// codes, the map list, and how a match is won.
//
// One copy for both sides. The server imports it as part of its own source;
// the frontend imports it by relative path (src/game/room.ts, maps.ts, …).
// It lives under server/ because Render builds the server from server/ alone
// and cannot see files outside it. Keep it pure: no Node, DOM or three.js
// imports, so it compiles in both packages.

/** Hard ceiling on a match. */
export const MAX_PLAYERS = 4;
/** The smallest room a host may ask for: a match needs an opponent. */
export const MIN_PLAYERS = 2;
/** Player names are cut to this many characters. */
export const NAME_MAX = 16;
/** Ink palette size; every player in a room gets a different index. */
export const INK_COUNT = 6;
/** How long a dropped player (reload, lost network) keeps their seat, s. */
export const RECONNECT_SECONDS = 30;

/** First to this many kills wins the match. */
export const KILLS_TO_WIN = 15;
/** How long a player stays down before respawning, ms. */
export const RESPAWN_MS = 3200;
/** How often a client sends its body, and the room patches state (Hz). */
export const MOVE_RATE_HZ = 20;

export const MAP_IDS = ["district", "valley", "sanctuary", "tomb"] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = "district";

export function isMapId(value: unknown): value is MapId {
  return typeof value === "string" && (MAP_IDS as readonly string[]).includes(value);
}

/** Unambiguous alphabet for room codes: no O/0, no I/1. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 4;

/** A new room code in the shape the lobby shows. */
export function drawRoomCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return s;
}
