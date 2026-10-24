// The weapon rack, the player-versus-player damage table and the katana: one
// copy for the engine (src/game/arsenal.ts re-exports it) and the match
// server (src/combat.ts derives its guns from it). See rules.ts for why this
// lives under server/.

export type WeaponDef = {
  name: string;
  kind: string;
  hint: string;
  magSize: number;
  reserve: number;
  maxReserve: number;
  interval: number;
  damage: number;
  headMul: number;
  pellets: number;
  spread: number;
  adsSpread: number;
  reloadTime: number;
  auto: boolean;
  zoom: number;
  katana?: boolean;
};

/**
 * The rack the engine plays with. `damage`/`headMul` here are the solo values,
 * tuned against the waves; online play uses PVP below.
 */
export const WEAPONS: WeaponDef[] = [
  { name: "RIFLE", kind: "rifle", hint: "auto · put the red dot on them", magSize: 35, reserve: 175, maxReserve: 350, interval: 1 / 11, damage: 24, headMul: 2.6, pellets: 1, spread: 0.016, adsSpread: 0.0034, reloadTime: 1.45, auto: true, zoom: 58 },
  { name: "SHOTGUN", kind: "shotgun", hint: "pump · devastating up close", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.78, damage: 19, headMul: 1.8, pellets: 10, spread: 0.062, adsSpread: 0.034, reloadTime: 2.0, auto: false, zoom: 68 },
  { name: "SNIPER", kind: "sniper", hint: "scoped bolt action · one shot, one erasure", magSize: 5, reserve: 25, maxReserve: 50, interval: 0.9, damage: 150, headMul: 3, pellets: 1, spread: 0.075, adsSpread: 0.0004, reloadTime: 2.1, auto: false, zoom: 20 },
  { name: "KATANA", kind: "katana", hint: "slash · hold aim to block & return bullets", magSize: Infinity, reserve: Infinity, maxReserve: Infinity, interval: 0.27, damage: 75, headMul: 1.6, pellets: 1, spread: 0, adsSpread: 0, reloadTime: 0, auto: false, zoom: 82, katana: true },
  { name: "REVOLVER", kind: "revolver", hint: "hand cannon · headshots erase", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.3, damage: 62, headMul: 3, pellets: 1, spread: 0.006, adsSpread: 0.002, reloadTime: 1.9, auto: false, zoom: 52 },
];

/** Every weapon a player can hold, in rack order. */
export const WEAPON_NAMES = WEAPONS.map((w) => w.name);
export const DEFAULT_WEAPON = "RIFLE";

/**
 * Player-versus-player numbers: what the match server applies and the health
 * bar measures.
 *
 * The rack above is tuned for the solo waves, against enemies with hundreds of
 * health and a player with 120. Played straight against other players it
 * erased someone in five rifle hits (a third of a second of fire) and with any
 * single sniper body shot. These keep each weapon's role and leave fire rate,
 * spread, magazines and reloads alone; against PVP.health:
 *
 *   RIFLE     12 body shots (≈1.1 s of fire), 6 headshots
 *   SHOTGUN   80 point-blank if every pellet lands: two pumps up close
 *   SNIPER    2 body shots, a headshot erases
 *   REVOLVER  4 body shots, 2 headshots
 *   KATANA    3 cuts, 2 head cuts
 */
export const PVP = {
  health: 100,
  weapons: {
    RIFLE: { damage: 9, headMul: 2 },
    SHOTGUN: { damage: 8, headMul: 1.5 },
    SNIPER: { damage: 80, headMul: 1.5 },
    KATANA: { damage: 40, headMul: 1.5 },
    REVOLVER: { damage: 30, headMul: 2 },
  } as Record<string, { damage: number; headMul: number }>,
  /** the focus dash's finishing hit */
  focusDash: 60,
  /** a grenade's centre damage to its thrower; everyone else takes 1.5× */
  grenade: 60,
} as const;

/**
 * Melee configuration for the katana.
 *
 * A blade is not a short-range gun: it has no projectile, no muzzle flash and
 * no hitscan ray, so its whole behaviour lives in these numbers. Reach and arc
 * are the forward hitbox (the engine sweeps both against enemy rigs and against
 * other players); the focus fields say what a landed hit is worth on the meter.
 */
export type MeleeConfig = {
  /** how far the blade reaches from the eye, in world units */
  reach: number;
  /** half-angle of the hit cone, as a cosine (0.35 ≈ ±70°) */
  cosArc: number;
  /** what a landed slash takes off a body (solo; online uses PVP.weapons.KATANA) */
  damage: number;
  /** head multiplier for a slash that catches the head of the arc */
  headMul: number;
  /** one landed slash fills this much of the focus meter (three fills it) */
  focusGain: number;
  /** folding an incoming round back fills a larger chunk — the riskier play */
  deflectGain: number;
};

export const KATANA_MELEE: MeleeConfig = {
  reach: 2.9,
  cosArc: 0.35,
  damage: 75,
  headMul: 1.6,
  focusGain: 0.34,
  deflectGain: 0.5,
};
