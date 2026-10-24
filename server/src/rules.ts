// Match rules the server enforces.
//
// The values both sides must agree on (limits, map ids, room codes) live in
// shared/rules.ts, which the frontend imports too; this module adds what only
// the server does with them: normalising a create request, sanitising names,
// handing out inks.

import { DEFAULT_MAP, INK_COUNT, isMapId, MAX_PLAYERS, MIN_PLAYERS, NAME_MAX, type MapId } from "./shared/rules.js";

export {
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_MAP,
  drawRoomCode,
  INK_COUNT,
  isMapId,
  MAP_IDS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NAME_MAX,
  RECONNECT_SECONDS,
  type MapId,
} from "./shared/rules.js";

export type MatchConfig = { map: MapId; grapple: boolean };

export type MatchOptions = MatchConfig & { maxPlayers: number };

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

/** The lowest ink index nobody in `used` holds. */
export function freeInk(used: Iterable<number>): number {
  const taken = new Set(used);
  for (let i = 0; i < INK_COUNT; i++) if (!taken.has(i)) return i;
  return 0;
}
