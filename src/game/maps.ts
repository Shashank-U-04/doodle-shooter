// The map roster, shared by the engine, the setup screen and the net layer.
//
// One identifier is the single source of truth for "which battlefield". The
// URL, the match configuration, the engine's `MapId` and the host's lobby
// settings all speak these four strings.
//
// Ancient Egypt is authored as three zones in one builder (see egypt.ts), but
// each zone is independently playable: `zone` below is the area the engine
// starts in, not a doorway the player has to walk through.

import type { ZoneId } from "./egypt";

export type MapId = "district" | "valley" | "sanctuary" | "tomb";

export type MapInfo = {
  id: MapId;
  /** the map's in-world name, shown on the selector and on the area HUD */
  name: string;
  /** one line under the name */
  tagline: string;
  /** two or three sentences for the selector */
  description: string;
  /** which Egypt zone the engine should load (absent for the district) */
  zone?: ZoneId;
};

export const MAPS: MapInfo[] = [
  {
    id: "district",
    name: "DOODLE DISTRICT",
    tagline: "street level · rooftops · waves incoming",
    description:
      "The original arena: tight alleys, climbable stairs and a skyline drawn in one continuous line. Waves pour in from every corner.",
    zone: undefined,
  },
  {
    id: "valley",
    name: "THE PHARAOH'S VALLEY",
    tagline: "open desert · three pyramids · temple · sphinx",
    description:
      "The great pyramid and two smaller enterable tombs, a colonnaded temple with a hidden alcove, a sphinx, obelisks, ruins, dunes and a dry canyon. No coastline, no sea.",
    zone: "surface",
  },
  {
    id: "sanctuary",
    name: "THE FORGOTTEN SANCTUARY",
    tagline: "pyramid interior · columns · hidden stair",
    description:
      "A low processional corridor into a carved sandstone chamber with hieroglyph walls, torchlight, an armed floor trap and the concealed dais hatch that leads down.",
    zone: "interior",
  },
  {
    id: "tomb",
    name: "THE CURSED TOMB",
    tagline: "burial halls · sealed doors · mummies",
    description:
      "Burial chambers, a treasure vault and a pharaoh's room; sealed stone doors, sarcophagi, a pressure plate, spike pits, levers and a hidden wall.",
    zone: "tomb",
  },
];

export const DEFAULT_MAP: MapId = "district";

export function isMapId(value: unknown): value is MapId {
  return value === "district" || value === "valley" || value === "sanctuary" || value === "tomb";
}

export function mapInfo(id: MapId): MapInfo {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/** URL/query values are untrusted: always land on a real map. */
export function normalizeMapId(value: string | null | undefined): MapId {
  return isMapId(value) ? value : DEFAULT_MAP;
}

/** Per-match gameplay configuration. Separate from permanent user settings. */
export type MatchConfig = {
  map: MapId;
  /** the grappling hook exists in the engine; this decides whether a match has it */
  grapple: boolean;
};

export const DEFAULT_MATCH_CONFIG: MatchConfig = { map: DEFAULT_MAP, grapple: true };

export function normalizeMatchConfig(value: unknown): MatchConfig {
  const v = value && typeof value === "object" ? (value as Partial<MatchConfig>) : {};
  return {
    map: isMapId(v.map) ? v.map : DEFAULT_MAP,
    grapple: typeof v.grapple === "boolean" ? v.grapple : true,
  };
}

export type GameMode = "solo" | "friends";

export type SetupState = MatchConfig & {
  mode: GameMode;
  name: string;
};

const SETUP_KEY = "dd_setup";

const emptySetup: SetupState = { ...DEFAULT_MATCH_CONFIG, mode: "solo", name: "" };

/**
 * Screen-two state survives a route change or a Back press, but not a new tab.
 *
 * sessionStorage is deliberate: a match configuration is not a permanent
 * preference, so it must not leak into tomorrow's run, and a fresh tab should
 * start from the defaults.
 */
export function readSetup(): SetupState {
  try {
    const raw = sessionStorage.getItem(SETUP_KEY);
    if (!raw) return { ...emptySetup };
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    return {
      ...normalizeMatchConfig(parsed),
      mode: parsed.mode === "friends" ? "friends" : "solo",
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 16) : "",
    };
  } catch {
    return { ...emptySetup };
  }
}

export function writeSetup(patch: Partial<SetupState>): SetupState {
  const next = { ...readSetup(), ...patch };
  const clean: SetupState = {
    ...normalizeMatchConfig(next),
    mode: next.mode === "friends" ? "friends" : "solo",
    name: String(next.name ?? "").slice(0, 16),
  };
  try {
    sessionStorage.setItem(SETUP_KEY, JSON.stringify(clean));
  } catch {
    /* private mode: the route still carries the choice */
  }
  return clean;
}

/** Read a map out of a URL, falling back to the session's setup state. */
export function mapFromQuery(search: string): MapId {
  const q = new URLSearchParams(search);
  const value = q.get("map");
  if (value) return normalizeMapId(value);
  return readSetup().map;
}

/** Grapple flag from a URL: absent means "the match default". */
export function grappleFromQuery(search: string): boolean {
  const q = new URLSearchParams(search);
  const value = q.get("grapple");
  if (value === "0" || value === "off") return false;
  if (value === "1" || value === "on") return true;
  return readSetup().grapple;
}

/** The query string that carries a solo match into /game. */
export function gameHref(config: MatchConfig): string {
  return `/game?map=${config.map}&grapple=${config.grapple ? 1 : 0}`;
}
