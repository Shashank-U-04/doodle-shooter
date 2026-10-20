// Match rules the server enforces.
//
// These mirror the browser's lobby (src/game/room.ts, src/game/maps.ts and the
// limits in src/game/net.ts) so a player sees the same codes, maps and limits
// whichever transport carries the match. The server is a separate package and
// cannot import the frontend, so the values are repeated here; the map list is
// checked against src/game/maps.ts by test/rules.test.ts.

/** Hard ceiling on a match, the same as the PeerJS lobby's MAX_PLAYERS. */
export const MAX_PLAYERS = 4;
/** The smallest room a host may ask for: a match needs an opponent. */
export const MIN_PLAYERS = 2;
/** Player names are cut to this many characters, as in NetSession. */
export const NAME_MAX = 16;
/** Ink palette size; every player in a room gets a different index. */
export const INK_COUNT = 6;
/** How long a dropped player (reload, lost network) keeps their seat. */
export const RECONNECT_SECONDS = 30;

export const MAP_IDS = ["district", "valley", "sanctuary", "tomb"] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = "district";

/** Unambiguous alphabet (no O/0, no I/1), identical to src/game/room.ts. */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 4;

export type MatchConfig = { map: MapId; grapple: boolean };

export type MatchOptions = MatchConfig & { maxPlayers: number };

export function isMapId(value: unknown): value is MapId {
  return typeof value === "string" && (MAP_IDS as readonly string[]).includes(value);
}

/**
 * A display name that is safe to put in front of other players: no control
 * characters, no surrounding whitespace, at most NAME_MAX characters.
 */
export function sanitizeName(raw: unknown, fallback: string): string {
  const name = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name || fallback;
}

/**
 * Room options from whoever created the room. Like normalizeMatchConfig in the
 * browser, anything unknown or malformed falls back to the default instead of
 * failing the create; the player limit is clamped to what the game supports.
 */
export function normalizeMatchOptions(value: unknown): MatchOptions {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const requested = Number(v.maxPlayers);
  const maxPlayers = Number.isInteger(requested)
    ? Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, requested))
    : MAX_PLAYERS;
  return {
    map: isMapId(v.map) ? v.map : DEFAULT_MAP,
    grapple: typeof v.grapple === "boolean" ? v.grapple : true,
    maxPlayers,
  };
}

/** A new room code in the same shape the lobby already shows. */
export function drawRoomCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return s;
}

/** The lowest ink index nobody in `used` holds. */
export function freeInk(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let i = 0; i < INK_COUNT; i++) if (!taken.has(i)) return i;
  return 0;
}
