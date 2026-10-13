// Weapon definitions transcribed from the original zr={} table, plus shared helpers.

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
  /** what a landed slash takes off a body */
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

export type WeaponDef = {
  name: string;
  hint: string;
  kind: "rifle" | "shotgun" | "sniper" | "revolver" | "katana";
  /** present only on melee weapons; the engine reads the blade from here */
  melee?: MeleeConfig;
  magSize: number;
  reserve: number;
  maxReserve: number;
  interval: number;
  damage: number;
  headMul: number;
  pellets: number;
  spread: number;
  adsSpread: number;
  spreadKick: number;
  spreadMax: number;
  adsFov: number;
  sight: [number, number, number, number];
  camKick: [number, number];
  fovKick: number;
  reloadDur: number;
  reloadType: "mag" | "shells" | "cylinder" | "none";
  auto: boolean;
  falloff: [number, number, number] | null;
  moveSpread: number;
  scope?: boolean;
};

export const WEAPONS: WeaponDef[] = [
  {
    name: "RIFLE",
    hint: "auto · put the red dot on them",
    kind: "rifle",
    magSize: 35,
    reserve: 175,
    maxReserve: 350,
    interval: 1 / 11,
    damage: 24,
    headMul: 2.6,
    pellets: 1,
    spread: 0.016,
    adsSpread: 0.0034,
    spreadKick: 0.009,
    spreadMax: 0.075,
    adsFov: 58,
    sight: [0, 0.12, -0.05, 0.3],
    camKick: [0.009, 0.0034],
    fovKick: 1.2,
    reloadDur: 1.45,
    reloadType: "mag",
    auto: true,
    falloff: null,
    moveSpread: 0.0012,
  },
  {
    name: "SHOTGUN",
    hint: "pump · devastating up close",
    kind: "shotgun",
    magSize: 6,
    reserve: 36,
    maxReserve: 72,
    interval: 0.78,
    damage: 19,
    headMul: 1.8,
    pellets: 10,
    spread: 0.062,
    adsSpread: 0.034,
    spreadKick: 0,
    spreadMax: 0.1,
    adsFov: 68,
    sight: [0, 0.095, -1, 0.52],
    camKick: [0.05, 0.012],
    fovKick: 4,
    reloadDur: 0.45,
    reloadType: "shells",
    auto: false,
    falloff: [11, 32, 0.22],
    moveSpread: 0.0006,
  },
  {
    name: "SNIPER",
    hint: "scoped bolt action · one shot, one erasure",
    kind: "sniper",
    magSize: 5,
    reserve: 25,
    maxReserve: 50,
    interval: 0.2,
    damage: 150,
    headMul: 3,
    pellets: 1,
    spread: 0.075,
    adsSpread: 0.0004,
    spreadKick: 0.05,
    spreadMax: 0.14,
    adsFov: 20,
    sight: [0, 0.135, 0, 0.42],
    camKick: [0.055, 0.008],
    fovKick: 4.5,
    reloadDur: 2.1,
    reloadType: "mag",
    auto: false,
    falloff: null,
    moveSpread: 0.004,
    scope: true,
  },
  {
    name: "KATANA",
    hint: "slash · hold aim to block & return bullets",
    kind: "katana",
    magSize: Infinity,
    reserve: Infinity,
    maxReserve: Infinity,
    interval: 0.27,
    damage: 75,
    headMul: 1.6,
    pellets: 1,
    spread: 0,
    adsSpread: 0,
    spreadKick: 0,
    spreadMax: 0,
    adsFov: 82,
    sight: [0, 0, 0, 0],
    camKick: [0.01, 0.002],
    fovKick: 0.8,
    reloadDur: 0,
    reloadType: "none",
    auto: false,
    falloff: null,
    moveSpread: 0,
    melee: KATANA_MELEE,
  },
  {
    name: "REVOLVER",
    hint: "hand cannon · headshots erase",
    kind: "revolver",
    magSize: 6,
    reserve: 36,
    maxReserve: 72,
    interval: 0.3,
    damage: 62,
    headMul: 3,
    pellets: 1,
    spread: 0.006,
    adsSpread: 0.002,
    spreadKick: 0.02,
    spreadMax: 0.06,
    adsFov: 52,
    sight: [0, 0.08, -0.34, 0.42],
    camKick: [0.038, 0.007],
    fovKick: 2.5,
    reloadDur: 1.9,
    reloadType: "cylinder",
    auto: false,
    falloff: null,
    moveSpread: 0.0015,
  },
];
