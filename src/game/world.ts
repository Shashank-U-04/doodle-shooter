// Game world building: materials, colliders, arena, and sketchy ragdoll enemies.

import * as THREE from "three";
import { INK_FRAG, INK_VERT } from "./shaders";

export const INK = { BLUE: 0, RED: 1, BLACK: 2, ORANGE: 3, GREEN: 4, PINK: 5 } as const;
export type InkId = (typeof INK)[keyof typeof INK];

// The reference game's ink palette, verbatim.
export const INK_RGB: Record<InkId, [number, number, number]> = {
  [INK.BLUE]: [0.1, 0.19, 0.76],
  [INK.RED]: [0.86, 0.12, 0.2],
  [INK.BLACK]: [0.18, 0.2, 0.26],
  [INK.ORANGE]: [0.92, 0.55, 0.08],
  [INK.GREEN]: [0.12, 0.6, 0.3],
  [INK.PINK]: [0.9, 0.4, 0.66],
};

export const INK_HEX: Record<InkId, string> = {
  [INK.BLUE]: "#1a30c2",
  [INK.RED]: "#db1f33",
  [INK.BLACK]: "#2e3342",
  [INK.ORANGE]: "#eb8c14",
  [INK.GREEN]: "#1f994d",
  [INK.PINK]: "#e666a8",
};

// paper: (0.965, 0.955, 0.905) in the reference renderer
export const PAPER_RGB: [number, number, number] = [0.965, 0.955, 0.905];
export const PAPER = 0xf6f4e7;
export const PAPER_HEX = "#f6f4e7";

// The sketch "studio light": kept in view space, so the shading is anchored
// to the camera the way the reference game does it.
export const LIGHT_DIR_WORLD = new THREE.Vector3(0.38, 0.82, 0.42).normalize();

export const shared = {
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0, 1, 0) },
};

// One material per (ink, fill mode, side, flat flag), shared by everything that
// uses it. Without the cache every bullet, every shard, every splat and every
// bucket of every enemy rig allocated its own ShaderMaterial — hundreds of new
// materials per wave, which the renderer has to register, upload uniforms for
// and garbage-collect, exactly when the screen is busiest. Nothing mutates a
// material's uniforms after creation, so sharing is safe.
const inkMaterials = new Map<number, THREE.ShaderMaterial>();

export function makeInkMaterial(
  ink: InkId,
  fill = false,
  side: THREE.Side = THREE.FrontSide,
  flat = false,
): THREE.ShaderMaterial {
  const key = ink | (fill ? 8 : 0) | (side === THREE.BackSide ? 16 : side === THREE.DoubleSide ? 32 : 0) | (flat ? 64 : 0);
  const cached = inkMaterials.get(key);
  if (cached) return cached;
  const made = new THREE.ShaderMaterial({
    uniforms: {
      uInk: { value: ink },
      uFill: { value: fill ? 1 : 0 },
      uFlat: { value: flat ? 1 : 0 },
      uShadeScale: { value: 1 },
      uShadeBias: { value: 0 },
      uLightDir: shared.uLightDir,
      uTime: shared.uTime,
    },
    vertexShader: INK_VERT,
    fragmentShader: INK_FRAG,
    side,
  });
  inkMaterials.set(key, made);
  return made;
}

/* ============================== AABB colliders ============================== */

export type AABB = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

export function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
): AABB {
  return { minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2 };
}

export type Collider = AABB;

/**
 * Does a body of `radius`/`height` standing at (x, y, z) intersect `c`?
 *
 * Strict inequalities on purpose: standing exactly on a surface, or exactly
 * against a wall, is *not* inside it. Every geometric question in the engine —
 * movement, spawn pads, unsticking — goes through this one predicate, so none
 * of them can disagree about what counts as an overlap.
 */
export function bodyHits(x: number, y: number, z: number, radius: number, height: number, c: Collider): boolean {
  return (
    x + radius > c.minX &&
    x - radius < c.maxX &&
    z + radius > c.minZ &&
    z - radius < c.maxZ &&
    y < c.maxY &&
    y + height > c.minY
  );
}

/**
 * Is this a spot a body can actually stand on: clear of every collider, with a
 * floor within `reach` of its feet?
 *
 * This is the test a spawn pad has to pass. A pad inside a building, under a
 * walkway or hanging over a void passes a naive "is it in the list?" check and
 * fails here — which is the whole point, because a teleport into geometry is a
 * player who cannot move.
 */
export function isStandable(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  colliders: Collider[],
  reach = 1.2,
): boolean {
  for (const c of colliders) if (bodyHits(x, y, z, radius, height, c)) return false;

  let floor = -Infinity;
  for (const c of colliders) {
    // the collider has to be under the footprint…
    if (x + radius <= c.minX || x - radius >= c.maxX) continue;
    if (z + radius <= c.minZ || z - radius >= c.maxZ) continue;
    // …below the feet (anything at or above them is an obstruction, and was
    // already rejected as an overlap above)…
    if (c.maxY > y + 0.05) continue;
    // …and close enough to be the surface we would stand on rather than a kerb
    // far below that we would step off into thin air.
    if (c.maxY < y - reach) continue;
    if (c.maxY > floor) floor = c.maxY;
  }
  return floor > -Infinity;
}

/**
 * AABB depth-penetration resolution for a *teleport*: the shortest way out of
 * whatever the body is overlapping, return true if it moved.
 *
 * Deliberately narrower than the version inside resolveMove, which is allowed to
 * drop a body out of the bottom of a box because movement put it there. A
 * teleport has no such excuse, and "down" is how a respawn ends up under the
 * ground with no way back — so this variant only ever escapes sideways or up.
 */
export function depenetrate(
  pos: THREE.Vector3,
  radius: number,
  height: number,
  colliders: Collider[],
  iterations = 4,
): boolean {
  let moved = false;
  for (let i = 0; i < iterations; i++) {
    let hit: Collider | null = null;
    for (const c of colliders) {
      if (bodyHits(pos.x, pos.y, pos.z, radius, height, c)) {
        hit = c;
        break;
      }
    }
    if (!hit) break;
    moved = true;
    const c = hit;
    const up = c.maxY - pos.y; // stand on top of it
    const px = c.maxX + radius - pos.x;
    const nx = pos.x - (c.minX - radius);
    const pz = c.maxZ + radius - pos.z;
    const nz = pos.z - (c.minZ - radius);
    const side = Math.min(px, nx, pz, nz);
    if (up <= side) {
      pos.y = c.maxY; // knee-high overlap: treat it as a step
    } else if (px <= nx && px <= pz && px <= nz) {
      pos.x = c.maxX + radius;
    } else if (nx <= pz && nx <= nz) {
      pos.x = c.minX - radius;
    } else if (pz <= nz) {
      pos.z = c.maxZ + radius;
    } else {
      pos.z = c.minZ - radius;
    }
  }
  return moved;
}

/** What makes one spawn pad better than another, once it is safe at all. */
export type SpawnScoring = {
  radius: number;
  height: number;
  colliders: Collider[];
  /** ignore pads above this height — keeps a respawn at street level */
  groundOnly?: number;
  /** higher wins; equal scores keep the earlier pad */
  score?: (pad: THREE.Vector3) => number;
};

/**
 * The best *safe* pad of `candidates`, or null when every one of them is inside
 * geometry.
 *
 * Callers keep a list of known-good corners as the next resort, so one broken
 * pad degrades into a good spawn instead of a stuck player.
 */
export function pickSafeSpawn(candidates: THREE.Vector3[], opts: SpawnScoring): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null;
  let bestScore = -Infinity;
  for (const pad of candidates) {
    if (opts.groundOnly !== undefined && pad.y > opts.groundOnly) continue;
    if (!isStandable(pad.x, pad.y, pad.z, opts.radius, opts.height, opts.colliders)) continue;
    const s = opts.score ? opts.score(pad) : 0;
    if (best === null || s > bestScore) {
      best = pad;
      bestScore = s;
    }
  }
  return best;
}

/* ============================== combat geometry ============================== */

/**
 * One replayable frame of a body, kept so a shot that arrives late can be
 * checked against where the body actually was when it was fired.
 */
export type PoseSample = { t: number; x: number; y: number; z: number; alive: boolean };

/**
 * The pose to validate a remote's shot against: the newest sample at or before
 * `now - rewindMs`.
 *
 * A hit message carries the shooter's half round trip, so rewinding by exactly
 * that much asks the only question that is fair — "was I standing there when
 * they pulled the trigger?" — instead of the one that is not — "am I standing
 * there now?", which two players on different connections answer differently.
 * Falls back to the oldest sample (never null for a non-empty buffer) so a
 * fresh client still has a body to be hit.
 */
export function poseAt(history: PoseSample[], now: number, rewindMs: number): PoseSample | null {
  if (history.length === 0) return null;
  const target = now - rewindMs;
  let best: PoseSample | null = null;
  for (const s of history) {
    if (s.t > target) continue;
    if (!best || s.t > best.t) best = s;
  }
  if (best) return best;
  let oldest = history[0];
  for (const s of history) if (s.t < oldest.t) oldest = s;
  return oldest;
}

/**
 * The melee test: is `point` inside a forward cone — within `reach` of the eye
 * and inside `cosArc` of where we are looking?
 *
 * A cone is the honest shape for a blade: it has no magazine, no tracer and no
 * travel time, so the question is only ever "is it in front of me and close",
 * which is what a player expects a slash to answer. `cosArc` is a cosine, so
 * 0.35 is roughly ±70°.
 */
export function meleeHits(
  eye: THREE.Vector3,
  fwd: THREE.Vector3,
  point: THREE.Vector3,
  reach: number,
  cosArc: number,
): boolean {
  const to = point.clone().sub(eye);
  const d = to.length();
  if (d > reach) return false;
  if (d < 1e-4) return true;
  return to.divideScalar(d).dot(fwd) >= cosArc;
}

/**
 * A tolerant body test for validating a remote's shot: does the segment
 * `from → to` pass through a body standing at `feet` of `radius`/`height`?
 *
 * Deliberately a *box plus head sphere* sampled every 25 cm and deliberately
 * wider than the body itself. Two players only ever see each other's packet
 * positions, so an exact test would reject honest hits whenever the rigs differ
 * by a few centimetres — which, at four players, is most of the time. The slack
 * is what turns "imprecise hit registration" back into "their shot landed".
 */
export function segmentHitsBody(
  from: THREE.Vector3,
  to: THREE.Vector3,
  feet: THREE.Vector3,
  radius: number,
  height: number,
): boolean {
  const d = to.clone().sub(from);
  const len = d.length();
  if (len < 1e-6) return false;
  const steps = Math.min(64, Math.max(1, Math.ceil(len / 0.25)));
  const step = d.divideScalar(steps);
  const headY = feet.y + height - 0.16;
  const p = from.clone();
  for (let i = 0; i <= steps; i++) {
    if (i > 0) p.add(step);
    if (p.y < feet.y - 0.1 || p.y > feet.y + height + radius) continue;
    const dx = p.x - feet.x;
    const dz = p.z - feet.z;
    if (Math.abs(dx) <= radius && Math.abs(dz) <= radius) return true;
    // shoulders and hat are round on the rig: a sphere of slack around them
    const dy = p.y - headY;
    if (dx * dx + dz * dz + dy * dy <= radius * radius) return true;
  }
  return false;
}

export function resolveMove(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  radius: number,
  height: number,
  colliders: Collider[],
  dt: number,
  stepHeight = 0.55,
): { onGround: boolean; hitCeiling: boolean; hitWall: boolean } {
  let onGround = false;
  let hitCeiling = false;
  let hitWall = false;

  // Does the body (a box of `radius` around x/z, `height` tall from y up)
  // intersect this collider? The shared predicate, so a move and a spawn test
  // can never disagree about whether the body is inside something.
  const hits = (x: number, y: number, z: number, c: Collider) => bodyHits(x, y, z, radius, height, c);

  const anyHit = () => {
    for (const c of colliders) if (hits(pos.x, pos.y, pos.z, c)) return c;
    return null;
  };

  // Depenetration: push the body out of whatever it overlaps, along the
  // shortest escape. This is what makes the old "wedged between a wall and a
  // staircase with no way out" impossible — an overlap can never survive a
  // frame, so the player can always move free again.
  const depenetrate = () => {
    for (let i = 0; i < 3; i++) {
      const c = anyHit();
      if (!c) return;
      const up = c.maxY - pos.y; // climb out over the top
      const down = pos.y + height - c.minY; // slip out below the bottom
      const px = c.maxX + radius - pos.x;
      const nx = pos.x - (c.minX - radius);
      const pz = c.maxZ + radius - pos.z;
      const nz = pos.z - (c.minZ - radius);
      const side = Math.min(px, nx, pz, nz);
      if (up <= side && up <= stepHeight + 0.3) {
        // stair-scale overlap: step out on top, as if it were a tread
        pos.y = c.maxY;
        onGround = true;
      } else if (side <= down) {
        if (px <= nx && px <= pz && px <= nz) pos.x = c.maxX + radius;
        else if (nx <= pz && nx <= nz) pos.x = c.minX - radius;
        else if (pz <= nz) pos.z = c.maxZ + radius;
        else pos.z = c.minZ - radius;
      } else {
        pos.y = c.minY - height;
        vel.y = Math.min(vel.y, 0);
        hitCeiling = true;
      }
    }
  };

  // If a previous frame left us inside geometry — squeezed between boxes, or
  // spawned into a prop — get clear BEFORE moving, not after.
  depenetrate();

  const tryAxis = (axis: "x" | "y" | "z", delta: number) => {
    if (delta === 0) return;
    const saved = pos[axis];
    pos[axis] = saved + delta;
    for (const c of colliders) {
      if (!hits(pos.x, pos.y, pos.z, c)) continue;
      if (axis === "y") {
        if (delta < 0) {
          pos.y = c.maxY;
          onGround = true;
          vel.y = 0;
        } else {
          pos.y = c.minY - height;
          hitCeiling = true;
          vel.y = 0;
        }
      } else {
        // Step-up assist: a knee-high ledge becomes floor — but only if the
        // whole body clears the space above it. Lifting into a lintel, rail or
        // ceiling is exactly how players used to end up jammed inside walls.
        if (c.maxY - pos.y <= stepHeight && c.maxY - pos.y > -0.01) {
          const oldY = pos.y;
          pos.y = c.maxY;
          if (!anyHit()) continue;
          pos.y = oldY;
        }
        // Clamp back out only when this move is what entered the box. If the
        // body was already inside it, clamping would drag us through the wall
        // to the far side — often into the next box, where two opposing
        // clamps pinned the player permanently. Leave those to depenetration.
        const wasInside = hits(
          axis === "x" ? saved : pos.x,
          pos.y,
          axis === "z" ? saved : pos.z,
          c,
        );
        if (wasInside) continue;
        pos[axis] =
          delta > 0
            ? (axis === "x" ? c.minX : c.minZ) - radius
            : (axis === "x" ? c.maxX : c.maxZ) + radius;
        vel[axis] = 0;
        hitWall = true;
      }
    }
  };

  tryAxis("x", vel.x * dt);
  tryAxis("z", vel.z * dt);
  tryAxis("y", vel.y * dt);

  // Whatever the frame did, end it outside every collider.
  depenetrate();

  return { onGround, hitCeiling, hitWall };
}

/* ============================== world ============================== */

export type World = {
  scene: THREE.Scene;
  colliders: Collider[];
  spawnPoints: THREE.Vector3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export function buildWorld(scene: THREE.Scene): World {
  const colliders: Collider[] = [];
  const spawnPoints: THREE.Vector3[] = [];
  const B = 52; // half-size of the playfield

  const boxMesh = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ink: InkId,
    fill = false,
    collide = true,
  ) => {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = makeInkMaterial(ink, fill);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y + h / 2, z);
    scene.add(mesh);
    if (collide) colliders.push(box(w, h, d, x, y, z));
    return mesh;
  };

  // ground plane (no fill — pure paper street)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(B * 2 + 40, B * 2 + 40), makeInkMaterial(INK.BLUE, false));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  colliders.push({ minX: -B - 20, maxX: B + 20, minY: -2, maxY: 0, minZ: -B - 20, maxZ: B + 20 });

  // grid of city blocks with sketchy buildings, awnings and fire escapes
  for (let bx = -1; bx <= 1; bx++) {
    for (let bz = -1; bz <= 1; bz++) {
      if (bx === 0 && bz === 0) continue;
      const cx = bx * 30;
      const cz = bz * 30;
      const w = rand(12, 20);
      const d = rand(12, 20);
      const h = rand(10, 22);
      const ink = choice<InkId>([INK.BLUE, INK.BLACK, INK.RED, INK.GREEN, INK.PINK]);
      boxMesh(w, h, d, cx, 0, cz, ink, Math.random() < 0.5);

      // rooftop lip
      boxMesh(w + 1.2, 0.6, d + 1.2, cx, h, cz, ink, false);

      // fire escape on one face
      if (Math.random() < 0.75) {
        const fy = 3;
        for (let i = 0; i < 3; i++) {
          const yy = fy + i * 3.4;
          const facing = Math.random() < 0.5 ? 1 : -1;
          const dx = facing > 0 ? cx + w / 2 + 0.9 : cx - w / 2 - 0.9;
          boxMesh(1.8, 0.25, 3.4, dx, yy, cz + rand(-3, 3), INK.BLACK, false);
          // small stairs
          boxMesh(0.9, 0.2, 1.2, dx + facing * 0.9, yy + 1.7, cz + rand(-3, 3), INK.BLACK, false);
        }
      }

      // awnings at street level
      if (Math.random() < 0.7) {
        const az = cz + (bz === 0 ? 0 : Math.sign(bz) * (d / 2 + 1.4));
        boxMesh(4.5, 0.3, 2.2, cx + rand(-3, 3), 3.1, az, Math.random() < 0.5 ? INK.RED : INK.ORANGE, true, false);
      }
    }
  }

  // central plaza fountain
  boxMesh(4.5, 1.1, 4.5, 0, 0, 0, INK.BLUE, false);
  boxMesh(1.6, 2.6, 1.6, 0, 1.1, 0, INK.BLACK, false);

  // street lamps
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = 20 + rand(-4, 4);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    boxMesh(0.22, 5.5, 0.22, x, 0, z, INK.BLACK, false);
    boxMesh(1.2, 0.3, 0.4, x, 5.5, z, INK.BLACK, false);
  }

  // rooftops walkways between some buildings
  for (let i = 0; i < 4; i++) {
    const y = rand(9, 12);
    const x = rand(-30, 30);
    const z = choice([-18, 18]) + rand(-4, 4);
    boxMesh(rand(8, 14), 0.5, 3.2, x, y, z, INK.BLUE, false);
  }

  // crates & cars scattered on the streets
  for (let i = 0; i < 14; i++) {
    const x = rand(-44, 44);
    const z = rand(-44, 44);
    if (Math.abs(x) < 6 && Math.abs(z) < 6) continue;
    const w = rand(1.6, 3.2);
    const h = rand(1.2, 2.4);
    boxMesh(w, h, rand(1.6, 3.2), x, 0, z, choice<InkId>([INK.ORANGE, INK.GREEN, INK.BLUE]), Math.random() < 0.4);
  }
  for (let i = 0; i < 6; i++) {
    const x = choice([-1, 1]) * rand(10, 44);
    const z = rand(-44, 44);
    boxMesh(4.2, 1.3, 2.0, x, 0, z, INK.RED, true); // sketchy cars
    boxMesh(2.4, 0.9, 1.8, x, 1.3, z, INK.RED, false);
  }

  // boundary walls
  const wallH = 14;
  boxMesh(B * 2 + 4, wallH, 1, 0, 0, -B - 1, INK.BLUE, false);
  boxMesh(B * 2 + 4, wallH, 1, 0, 0, B + 1, INK.BLUE, false);
  boxMesh(1, wallH, B * 2 + 4, -B - 1, 0, 0, INK.BLUE, false);
  boxMesh(1, wallH, B * 2 + 4, B + 1, 0, 0, INK.BLUE, false);

  // spawn points around the perimeter and streets
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = 26 + rand(-8, 14);
    spawnPoints.push(new THREE.Vector3(clamp(Math.cos(a) * r, -B + 4, B - 4), 0.2, clamp(Math.sin(a) * r, -B + 4, B - 4)));
  }

  return {
    scene,
    colliders,
    spawnPoints,
    bounds: { minX: -B + 2, maxX: B - 2, minZ: -B + 2, maxZ: B - 2 },
  };
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}
function choice<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
function clamp(v: number, a: number, b: number) {
  return Math.min(b, Math.max(a, v));
}

/* ============================== sketchy enemies ============================== */

export type EnemyKind = "grunt" | "rusher" | "bomber" | "sniper" | "flyer" | "heavy" | "shield" | "boss" | "eraser" | "inkblot";

export type EnemyDef = {
  hp: number;
  speed: number;
  weapon: string;
  range: number;
  stop: number;
  cool: [number, number];
  dmg: number;
  score: number;
  scale: number;
  name: string;
  ink: InkId;
  boss?: boolean;
  flying?: boolean;
  shield?: boolean;
  hat?: string;
};

export const ENEMY_DEFS: Record<EnemyKind, EnemyDef> = {
  grunt: { hp: 100, speed: 5.2, weapon: "rifle", range: 28, stop: 16, cool: [1.6, 2.6], dmg: 6, score: 100, scale: 1, name: "GRUNT", ink: INK.BLUE, hat: "cap" },
  rusher: { hp: 70, speed: 7.6, weapon: "blade", range: 3, stop: 1.9, cool: [1, 1.5], dmg: 15, score: 120, scale: 0.95, name: "RUSHER", ink: INK.RED, hat: "band" },
  bomber: { hp: 26, speed: 6.5, weapon: "bomb", range: 3.4, stop: 0, cool: [1.05, 1.05], dmg: 24, score: 150, scale: 0.9, name: "INK BOMB", ink: INK.BLACK },
  sniper: { hp: 60, speed: 3.6, weapon: "sniper", range: 90, stop: 90, cool: [2.8, 3.8], dmg: 22, score: 180, scale: 1.05, name: "SNIPER", ink: INK.GREEN, hat: "hood" },
  flyer: { hp: 40, speed: 6.2, weapon: "dive", range: 2.2, stop: 0, cool: [2.8, 4.2], dmg: 10, score: 140, scale: 1.5, name: "PAPER WASP", ink: INK.PINK, flying: true },
  heavy: { hp: 320, speed: 3, weapon: "shotgun", range: 18, stop: 9, cool: [2.4, 3.2], dmg: 5, score: 260, scale: 1.25, name: "HEAVY", ink: INK.ORANGE, hat: "helmet" },
  shield: { hp: 150, speed: 3.8, weapon: "pistol", range: 20, stop: 8, cool: [1.8, 2.6], dmg: 5, score: 200, scale: 1.05, name: "SHIELDBEARER", ink: INK.BLUE, shield: true, hat: "helmet" },
  boss: { hp: 2600, speed: 3.2, weapon: "boss", range: 32, stop: 6, cool: [2.6, 3.6], dmg: 22, score: 2500, scale: 2.7, name: "THE DOODLER", ink: INK.BLACK, boss: true, hat: "crown" },
  eraser: { hp: 3400, speed: 4.2, weapon: "boss", range: 30, stop: 8, cool: [2.2, 3.2], dmg: 26, score: 3200, scale: 2.6, name: "THE ERASER", ink: INK.PINK, boss: true },
  inkblot: { hp: 3000, speed: 3, weapon: "boss", range: 34, stop: 10, cool: [2.4, 3.4], dmg: 20, score: 3600, scale: 2.4, name: "THE INKBLOT", ink: INK.BLACK, boss: true },
};

export type Enemy = {
  kind: EnemyKind;
  def: EnemyDef;
  root: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  hatMesh: THREE.Mesh | null;
  shieldMesh: THREE.Mesh | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  hp: number;
  maxHp: number;
  alive: boolean;
  onGround: boolean;
  cooldown: number;
  t: number;
  strafe: number;
  dying: number;
};

function part(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  mat: THREE.Material,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

export function makeEnemyMesh(kind: EnemyKind, def: EnemyDef): { root: THREE.Group; head: THREE.Mesh; torso: THREE.Mesh; legL: THREE.Mesh; legR: THREE.Mesh; armL: THREE.Mesh; armR: THREE.Mesh; hatMesh: THREE.Mesh | null; shieldMesh: THREE.Mesh | null } {
  const root = new THREE.Group();
  const line = makeInkMaterial(def.ink, false);
  const fill = makeInkMaterial(def.ink, true);
  const s = def.scale;
  const bodyW = def.boss ? 1.35 : kind === "heavy" ? 1.55 : kind === "rusher" ? 0.82 : 1;
  const headS = def.boss ? 1.15 : 0.95;

  const torso = part(root, 0.62 * bodyW, 0.95, 0.38 * bodyW, 0, 1.15 * s, 0, line);
  const head = part(root, headS * 0.5, headS * 0.5, headS * 0.5, 0, 1.95 * s, 0, line);
  const legL = part(root, 0.2, 0.68, 0.2, -0.18 * bodyW, 0.47 * s, 0, fill);
  const legR = part(root, 0.2, 0.68, 0.2, 0.18 * bodyW, 0.47 * s, 0, fill);
  const armL = part(root, 0.16, 0.78, 0.16, -0.42 * bodyW, 1.15 * s, 0, fill);
  const armR = part(root, 0.16, 0.78, 0.16, 0.42 * bodyW, 1.15 * s, 0, fill);

  let hatMesh: THREE.Mesh | null = null;
  if (def.hat === "cap") hatMesh = part(root, 0.56, 0.14, 0.56, 0, 2.22 * s, 0.05, fill);
  if (def.hat === "helmet") hatMesh = part(root, 0.62, 0.2, 0.62, 0, 2.22 * s, 0, fill);
  if (def.hat === "band") hatMesh = part(root, 0.56, 0.1, 0.56, 0, 2.14 * s, 0, fill);
  if (def.hat === "hood") hatMesh = part(root, 0.58, 0.4, 0.58, 0, 2.1 * s, -0.05, fill);
  if (def.hat === "crown") hatMesh = part(root, 0.6, 0.22, 0.6, 0, 2.3 * s, 0, fill);

  let shieldMesh: THREE.Mesh | null = null;
  if (def.shield) {
    shieldMesh = part(root, 1.15, 1.15, 0.08, 0, 1.15 * s, 0.42 * bodyW, fill);
  }
  if (def.boss) {
    // boss blob silhouette
    part(root, 0.9, 0.5, 0.9, 0, 2.6 * s, 0, fill);
  }

  return { root, head, torso, legL, legR, armL, armR, hatMesh, shieldMesh };
}
