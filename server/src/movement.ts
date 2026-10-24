// Movement rules for synchronized player bodies.
//
// The game's physics runs in the browser (src/game/engine.ts): collision,
// grapple, dash and the map's doors all live there, and moving them here would
// mean a second physics engine. So a client *proposes* where its body is and
// the server decides what everyone else sees:
//
//  - the position is clamped into the map's playable volume;
//  - ordinary movement is speed-limited by a distance allowance that refills
//    at MAX_SPEED (a short burst is banked so packets that arrive bunched
//    after a network stall still go through);
//  - a teleport (the client changed its epoch: respawn, round restart, focus
//    dash, a door between Egypt's zones, the fall rescue) skips the speed
//    limit but is rate-limited, and still lands inside the volume.
//
// This keeps one bad or modified client from putting its body anywhere at any
// speed. It is not full anti-cheat: inside those limits the client still
// decides its own path (walls are not checked here).

import type { MapId } from "./rules.js";
import { MOVE_RATE_HZ } from "./shared/rules.js";
import { DEFAULT_WEAPON, WEAPON_NAMES } from "./shared/weapons.js";

/** How often clients send their body (Hz, shared/rules.ts). The room patches at the same rate. */
export { MOVE_RATE_HZ };
export const PATCH_INTERVAL_MS = 1000 / MOVE_RATE_HZ;

/**
 * Fastest ordinary movement, any direction (m/s). Walking is 6.6, sprinting
 * 10.6, a dash briefly 3.4× that (36); the rest is falls and grapple swings.
 */
export const MAX_SPEED = 60;
/** Movement allowance banked for bunched packets (m), i.e. half a second at MAX_SPEED. */
export const MOVE_BURST = 30;
/** Teleports allowed back to back (respawn + focus-dash chain), then one per second. */
export const TELEPORT_BURST = 3;
export const TELEPORT_REFILL_PER_S = 1;
/** Ceiling on any coordinate a client may send; beyond it the payload is garbage. */
export const COORD_LIMIT = 10_000;

/** The weapons a body can be drawn holding: the shared rack's names. */
export const WEAPONS: readonly string[] = WEAPON_NAMES;
export { DEFAULT_WEAPON };

export type Vec3 = { x: number; y: number; z: number };
export type Box = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

/**
 * Playable volume per map, measured from the real map builders (checked by
 * test/geometry.test.ts): each zone's x/z bounds, from just under the point
 * where the engine rescues a falling player (floor − 6) to well above the
 * tallest collider (jumps, double jumps and grapple swings).
 *
 * The three Egyptian maps are one connected world: a player who starts in the
 * valley can walk through a door into the sanctuary, so each of them allows
 * all three zones.
 */
const DISTRICT: Box = { minX: -55, maxX: 55, minY: -8, maxY: 41, minZ: -55, maxZ: 55 };
const SURFACE: Box = { minX: -59, maxX: 59, minY: -8, maxY: 42.5, minZ: -59, maxZ: 59 };
const INTERIOR: Box = { minX: -17, maxX: 17, minY: -148, maxY: -115.5, minZ: -17, maxZ: 17 };
const TOMB: Box = { minX: -49, maxX: 49, minY: -308, maxY: -276, minZ: -59, maxZ: 45 };
const EGYPT = [SURFACE, INTERIOR, TOMB];

export const ENVELOPES: Record<MapId, readonly Box[]> = {
  district: [DISTRICT],
  valley: EGYPT,
  sanctuary: EGYPT,
  tomb: EGYPT,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The closest point inside any of `boxes`. */
export function clampToEnvelope(p: Vec3, boxes: readonly Box[]): Vec3 {
  let best: Vec3 = p;
  let bestD = Infinity;
  for (const b of boxes) {
    const q = { x: clamp(p.x, b.minX, b.maxX), y: clamp(p.y, b.minY, b.maxY), z: clamp(p.z, b.minZ, b.maxZ) };
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2 + (q.z - p.z) ** 2;
    if (d === 0) return q;
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Any finite angle → (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t <= 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/** Looking straight up or down is the limit. */
export function clampPitch(p: number): number {
  return clamp(p, -Math.PI / 2, Math.PI / 2);
}

/** Per-player limiter state; lives on the server only, never synced. */
export type Motion = {
  /** metres of ordinary movement available right now */
  allowance: number;
  /** teleports available right now */
  teleports: number;
  /** server time of the last update, ms */
  lastAt: number;
  /** last epoch the client sent; null until its first move (or after a reconnect) */
  clientEpoch: number | null;
};

export function newMotion(now: number): Motion {
  return { allowance: MOVE_BURST, teleports: TELEPORT_BURST, lastAt: now, clientEpoch: null };
}

export type StepResult = {
  pos: Vec3;
  /** the body jumped rather than moved; viewers should snap to it */
  teleported: boolean;
};

/**
 * Decide where a body goes when its client claims `claim`.
 *
 * `prev` is where the server last put it (null: not placed yet). `wantsTeleport`
 * says the client stamped a new epoch. Mutates `m`.
 */
export function stepMotion(
  m: Motion,
  prev: Vec3 | null,
  claim: Vec3,
  wantsTeleport: boolean,
  now: number,
  envelope: readonly Box[],
): StepResult {
  const dt = Math.max(0, (now - m.lastAt) / 1000);
  m.lastAt = now;
  m.allowance = Math.min(MOVE_BURST, m.allowance + MAX_SPEED * dt);
  m.teleports = Math.min(TELEPORT_BURST, m.teleports + TELEPORT_REFILL_PER_S * dt);

  const target = clampToEnvelope(claim, envelope);
  if (!prev) return { pos: target, teleported: true };
  if (wantsTeleport && m.teleports >= 1) {
    m.teleports -= 1;
    return { pos: target, teleported: true };
  }

  const dx = target.x - prev.x;
  const dy = target.y - prev.y;
  const dz = target.z - prev.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= m.allowance) {
    m.allowance -= dist;
    return { pos: target, teleported: false };
  }
  // Too far, too fast: go as far as the allowance reaches, toward the claim.
  const f = dist > 0 ? m.allowance / dist : 0;
  m.allowance = 0;
  const step = { x: prev.x + dx * f, y: prev.y + dy * f, z: prev.z + dz * f };
  return { pos: clampToEnvelope(step, envelope), teleported: false };
}
