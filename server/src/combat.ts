// Combat rules for the match server.
//
// Every number here is the game's own, mirrored from the engine (the weapon
// rack in src/game/arsenal.ts, the katana in src/game/weapons.ts, and the
// literals in src/game/engine.ts that settle hits, blasts, health and the focus
// meter), except damage and health: those are the player-versus-player values
// in arsenal.ts's PVP table, since the rack's own are tuned for the solo waves.
// test/combat-parity.test.ts imports the frontend and fails if a value drifts. The geometry is the same too: the hitboxes and the ray-versus-box
// test are line-for-line ports of engine.ts, and the walls come from the real
// map builders (src/maps/colliders.json, see scripts/export-colliders.ts).
//
// What a client sends is only intent: "I fired this weapon from here, that way".
// Whether it may fire, where the pellets go, what they hit, the damage, the
// health left and who dies are all decided here.

import collidersJson from "./maps/colliders.json" with { type: "json" };
import type { MapId } from "./rules.js";
import { ENVELOPES, type Box, type Vec3 } from "./movement.js";

/* ------------------------------- the numbers ------------------------------- */

export type Gun = {
  name: string;
  magSize: number;
  interval: number;
  damage: number;
  headMul: number;
  pellets: number;
  spread: number;
  adsSpread: number;
  reloadTime: number;
};

/** src/game/arsenal.ts, the guns (the katana is MELEE below); damage and headMul from its PVP table. */
export const GUNS: Record<string, Gun> = {
  RIFLE: { name: "RIFLE", magSize: 35, interval: 1 / 11, damage: 9, headMul: 2, pellets: 1, spread: 0.016, adsSpread: 0.0034, reloadTime: 1.45 },
  SHOTGUN: { name: "SHOTGUN", magSize: 6, interval: 0.78, damage: 8, headMul: 1.5, pellets: 10, spread: 0.062, adsSpread: 0.034, reloadTime: 2.0 },
  SNIPER: { name: "SNIPER", magSize: 5, interval: 0.9, damage: 80, headMul: 1.5, pellets: 1, spread: 0.075, adsSpread: 0.0004, reloadTime: 2.1 },
  REVOLVER: { name: "REVOLVER", magSize: 6, interval: 0.3, damage: 30, headMul: 2, pellets: 1, spread: 0.006, adsSpread: 0.002, reloadTime: 1.9 },
};

/** The katana: KATANA_MELEE in weapons.ts (damage and headMul from PVP), its interval from arsenal.ts, the player-hit cones from katanaSlash(). */
export const MELEE = {
  name: "KATANA",
  interval: 0.27,
  reach: 2.9,
  cosArc: 0.35,
  /** a slash catches the head inside this tighter cone (katanaSlash, against players) */
  headCos: 0.9,
  damage: 40,
  headMul: 1.5,
  /** where the cones are aimed on a body, above its feet */
  chestY: 1.05,
  headY: 1.62,
  focusGain: 0.34,
} as const;

/** tryFocusDash() / addFocus(). */
export const FOCUS = {
  /** slow motion after the meter fills, s */
  slowmo: 2.6,
  /** dashes per slow-motion window before the meter locks */
  maxChain: 2,
  range: 14,
  /** forward cone of the dash, as a cosine */
  cos: 0.4,
  /** aimed at the body this far above its feet */
  aimY: 1,
  /** PVP.focusDash */
  damage: 60,
} as const;

/** throwGrenade() / updateGrenades() / explode(). */
export const GRENADE = {
  speed: 15,
  lift: 4,
  gravity: 20,
  /** updateGrenades bounces on this absolute height, whatever the zone */
  bounceY: 0.12,
  bounceUp: 0.4,
  bounceSide: 0.7,
  fuse: 1.6,
  /** explode(pos, 4.2, …, true): everyone inside 0.8 × 4.2 */
  radius: 4.2 * 0.8,
  /** PVP.grenade (the solo blast is 120) */
  damage: 60,
  /** blastRemotes() multiplies by 1.5 for the other players, not the thrower */
  othersMul: 1.5,
  cooldown: 0.6,
} as const;

/** raycastRemote() hitboxes, relative to a body's feet. */
export const HITBOX = { headY: 1.52, headR: 0.34, half: 0.42, height: 1.75 } as const;

/** fireWeapon(): raycastWorld(eye, dir, 160); walls lower than 1.2 m above the floor do not stop a round. */
export const RANGE = 160;
export const MIN_WALL_TOP = 1.2;
/** spread is 1.8× wider off the ground */
export const AIR_SPREAD = 1.8;

/** PVP.health, and the regen of updatePlayer() / damagePlayer(). */
export const HEALTH = { max: 100, regenDelay: 4.5, regenPerS: 11 } as const;
/** egypt.hazard(): a raised spike costs 12, at most once per 850 ms, never on the surface. */
export const SPIKE = { damage: 12, everyMs: 850 } as const;
/** Online.tsx: the respawn wait and the winning score. */
export const RESPAWN_MS = 3200;
export const KILLS_TO_WIN = 15;

/* --------------------------- server-side tolerances --------------------------- */

/** How far back a shot may be checked, ms: what the shooter saw is this old. */
export const MAX_REWIND_MS = 350;
/** A shot's origin may be this far from where the server last put the shooter's eye. */
export const ORIGIN_TOLERANCE = 3;
/**
 * Network jitter can deliver shots bunched together. Each weapon's budget may
 * hold this much time's worth of shots beyond the one that is ready, so a
 * bunch is not refused — but a slow gun still gets no extra shot from a pause
 * (a sniper's 900 ms interval leaves room for one; a rifle's 91 ms for ~2.6).
 */
export const FIRE_JITTER_MS = 150;
/** A reload may finish this much early on the server (the client started it a little before we heard). */
export const RELOAD_GRACE_MS = 150;
/** The focus window stays open this much longer on the server, for the same reason. */
export const FOCUS_GRACE_MS = 300;

/* ------------------------------- geometry ------------------------------- */

type Collider = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
type ZoneData = { floorY: number; colliders: number[][] };
export type ZoneId = "district" | "surface" | "interior" | "tomb";

const ZONES: Record<ZoneId, { floorY: number; colliders: Collider[] }> = Object.fromEntries(
  Object.entries(collidersJson as Record<string, ZoneData>).map(([id, z]) => [
    id,
    {
      floorY: z.floorY,
      colliders: z.colliders.map(([minX, minY, minZ, maxX, maxY, maxZ]) => ({ minX, minY, minZ, maxX, maxY, maxZ })),
    },
  ]),
) as Record<ZoneId, { floorY: number; colliders: Collider[] }>;

/** The zones of each map, in the same order as its movement envelope boxes. */
const MAP_ZONES: Record<MapId, ZoneId[]> = {
  district: ["district"],
  valley: ["surface", "interior", "tomb"],
  sanctuary: ["surface", "interior", "tomb"],
  tomb: ["surface", "interior", "tomb"],
};

function inBox(b: Box, p: Vec3) {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ;
}

/** The zone a point is in (bodies are always inside one; anything else gets the nearest by height). */
export function zoneAt(map: MapId, p: Vec3): { id: ZoneId; bounds: Box } {
  const boxes = ENVELOPES[map];
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    if (inBox(boxes[i], p)) return { id: MAP_ZONES[map][i], bounds: boxes[i] };
    const d = Math.min(Math.abs(p.y - boxes[i].minY), Math.abs(p.y - boxes[i].maxY));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { id: MAP_ZONES[map][best], bounds: boxes[best] };
}

export const zoneFloor = (id: ZoneId) => ZONES[id].floorY;

/** engine.ts rayAABB(): distance along `dir` to the box, or −1. */
export function rayAABB(o: Vec3, d: Vec3, c: Collider, maxDist: number): number {
  let tmin = 0;
  let tmax = maxDist;
  for (const axis of ["x", "y", "z"] as const) {
    const oa = o[axis];
    const da = d[axis];
    const mn = axis === "x" ? c.minX : axis === "y" ? c.minY : c.minZ;
    const mx = axis === "x" ? c.maxX : axis === "y" ? c.maxY : c.maxZ;
    if (Math.abs(da) < 1e-8) {
      if (oa < mn || oa > mx) return -1;
    } else {
      let t1 = (mn - oa) / da;
      let t2 = (mx - oa) / da;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/** engine.ts raycastWorld(): distance to the first wall of `zone`, or `maxDist`. */
export function raycastWorld(zone: ZoneId, o: Vec3, d: Vec3, maxDist: number): number {
  const z = ZONES[zone];
  let best = maxDist;
  for (const c of z.colliders) {
    if (c.maxY < z.floorY + MIN_WALL_TOP) continue;
    const t = rayAABB(o, d, c, best);
    if (t >= 0 && t < best) best = t;
  }
  return best;
}

export type Target = { id: string; feet: Vec3 };
export type RayHit = { id: string; dist: number; head: boolean; point: Vec3 };

/** engine.ts raycastRemote(): the nearest body in the line of fire, head first. */
export function raycastBodies(o: Vec3, d: Vec3, maxDist: number, targets: Target[]): RayHit | null {
  let best: RayHit | null = null;
  for (const t of targets) {
    const b = t.feet;
    const head = { x: b.x, y: b.y + HITBOX.headY, z: b.z };
    const toH = { x: head.x - o.x, y: head.y - o.y, z: head.z - o.z };
    const projH = toH.x * d.x + toH.y * d.y + toH.z * d.z;
    if (projH > 0 && projH < maxDist) {
      const px = o.x + d.x * projH - head.x;
      const py = o.y + d.y * projH - head.y;
      const pz = o.z + d.z * projH - head.z;
      if (Math.sqrt(px * px + py * py + pz * pz) < HITBOX.headR) {
        if (!best || projH < best.dist) best = { id: t.id, dist: projH, head: true, point: head };
        continue;
      }
    }
    const c = {
      minX: b.x - HITBOX.half,
      maxX: b.x + HITBOX.half,
      minY: b.y,
      maxY: b.y + HITBOX.height,
      minZ: b.z - HITBOX.half,
      maxZ: b.z + HITBOX.half,
    };
    const tt = rayAABB(o, d, c, maxDist);
    if (tt >= 0 && (!best || tt < best.dist)) {
      best = { id: t.id, dist: tt, head: false, point: { x: o.x + d.x * tt, y: o.y + d.y * tt, z: o.z + d.z * tt } };
    }
  }
  return best;
}

/** fireWeapon()'s per-pellet scatter: each axis nudged by ±spread, then renormalized. */
export function scatter(base: Vec3, spread: number, random: () => number = Math.random): Vec3 {
  const r = () => -spread + random() * 2 * spread;
  const x = base.x + r();
  const y = base.y + r();
  const z = base.z + r();
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

/** world.ts meleeHits(): `point` within `reach` of the eye and inside the cone. */
export function meleeHits(eye: Vec3, fwd: Vec3, point: Vec3, reach: number, cosArc: number): boolean {
  const tx = point.x - eye.x;
  const ty = point.y - eye.y;
  const tz = point.z - eye.z;
  const dist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (dist > reach) return false;
  if (dist < 1e-4) return true;
  return (tx * fwd.x + ty * fwd.y + tz * fwd.z) / dist >= cosArc;
}

/**
 * updateGrenades(), run at a fixed 120 Hz instead of the browser's frame rate:
 * where a grenade thrown from `eye` toward `fwd` is when its fuse runs out.
 */
export function grenadeLanding(eye: Vec3, fwd: Vec3, bounds: Box): Vec3 {
  const pos = { ...eye };
  const vel = { x: fwd.x * GRENADE.speed, y: fwd.y * GRENADE.speed + GRENADE.lift, z: fwd.z * GRENADE.speed };
  const dt = 1 / 120;
  for (let t = 0; t < GRENADE.fuse - 1e-9; t += dt) {
    vel.y -= GRENADE.gravity * dt;
    pos.x += vel.x * dt;
    pos.y += vel.y * dt;
    pos.z += vel.z * dt;
    if (pos.y < GRENADE.bounceY) {
      pos.y = GRENADE.bounceY;
      vel.y = Math.abs(vel.y) * GRENADE.bounceUp;
      vel.x *= GRENADE.bounceSide;
      vel.z *= GRENADE.bounceSide;
    }
    pos.x = Math.min(bounds.maxX, Math.max(bounds.minX, pos.x));
    pos.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, pos.z));
  }
  return pos;
}

/** explode(): what a blast at `at` does to a body whose feet are `feet`. */
export function blastDamage(at: Vec3, feet: Vec3, isThrower: boolean): number {
  const d = Math.sqrt((feet.x - at.x) ** 2 + (feet.y - at.y) ** 2 + (feet.z - at.z) ** 2);
  if (d >= GRENADE.radius) return 0;
  const f = Math.sqrt(Math.max(0, 1 - d / GRENADE.radius));
  return GRENADE.damage * f * (isThrower ? 1 : GRENADE.othersMul);
}

/* ------------------------------- per-player state ------------------------------- */

/** Firing, ammunition, focus and grenade state, server-side only. */
export type Arms = {
  /** rounds in each gun's magazine (reserve ammunition is not tracked; see README) */
  mags: Record<string, number>;
  /** shots available right now per weapon, refilled at 1 / interval, capped at capacityOf() */
  ready: Record<string, number>;
  readyAt: number;
  /** a reload in progress: which gun, and when it completes (server ms) */
  reload: { weapon: string; until: number } | null;
  /** the weapon the client last said it holds */
  weapon: string;
  /** last shot id accepted from this client (replays and duplicates are dropped) */
  lastShot: number;
  focus: number;
  slowmoUntil: number;
  chain: number;
  grenadeAt: number;
  hazardAt: number;
};

export function newArms(now: number, lastShot = 0): Arms {
  return {
    mags: Object.fromEntries(Object.values(GUNS).map((g) => [g.name, g.magSize])),
    ready: Object.fromEntries([...Object.keys(GUNS), MELEE.name].map((w) => [w, capacityOf(w)])),
    readyAt: now,
    reload: null,
    weapon: "RIFLE",
    lastShot,
    focus: 0,
    slowmoUntil: 0,
    chain: 0,
    grenadeAt: -Infinity,
    hazardAt: -Infinity,
  };
}

export const intervalOf = (weapon: string) => (weapon === MELEE.name ? MELEE.interval : GUNS[weapon].interval);
/** One shot, plus FIRE_JITTER_MS worth. */
export const capacityOf = (weapon: string) => 1 + FIRE_JITTER_MS / (intervalOf(weapon) * 1000);

/** Refill every weapon's shot budget for the time that passed. */
export function refill(a: Arms, now: number) {
  const dt = Math.max(0, (now - a.readyAt) / 1000);
  a.readyAt = now;
  for (const w of Object.keys(a.ready)) a.ready[w] = Math.min(capacityOf(w), a.ready[w] + dt / intervalOf(w));
  if (a.reload && now >= a.reload.until) {
    a.mags[a.reload.weapon] = GUNS[a.reload.weapon].magSize;
    a.reload = null;
  }
  // The meter's slow motion ending on its own clears the dash chain (engine: slowmoT <= 0).
  if (a.slowmoUntil > 0 && now >= a.slowmoUntil + FOCUS_GRACE_MS) {
    a.slowmoUntil = 0;
    a.chain = 0;
  }
}

/** Switching weapons cancels a reload in progress, as switchSlot() does. */
export function holdWeapon(a: Arms, weapon: string) {
  if (a.weapon === weapon) return;
  a.weapon = weapon;
  if (a.reload && a.reload.weapon !== weapon) a.reload = null;
}

/** engine.ts addFocus(). */
export function addFocus(a: Arms, amount: number, now: number) {
  a.focus = Math.min(1, Math.max(0, a.focus + amount));
  if (a.focus < 1 || now < a.slowmoUntil || a.chain >= FOCUS.maxChain) return;
  a.focus = 0;
  a.slowmoUntil = now + FOCUS.slowmo * 1000;
}

export const canDash = (a: Arms, now: number) =>
  a.slowmoUntil > 0 && now < a.slowmoUntil + FOCUS_GRACE_MS && a.chain < FOCUS.maxChain;

/** Health after `dt` seconds of regen, if the regen delay has passed. */
export function regen(hp: number, sinceHurtMs: number, dt: number): number {
  if (hp >= HEALTH.max || sinceHurtMs < HEALTH.regenDelay * 1000) return hp;
  return Math.min(HEALTH.max, hp + HEALTH.regenPerS * dt);
}
