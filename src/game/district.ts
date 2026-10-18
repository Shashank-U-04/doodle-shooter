// DOODLE DISTRICT — a transcription of the reference map builder, helper for helper.
//
// The helpers keep the reference's own argument order so the layout can be read
// against its source 1:1:
//   box(cx, y0, cz, w, h, d)        `box`   — an axis-aligned slab of ink
//   slab(x1, z1, x2, z2, y, t)      `slab`  — a floor/roof plate between two corners
//   wallX(minX, maxX, z, y0, h, t)  `wallX` — a wall running along X at a constant z
//   wallZ(minZ, maxZ, x, y0, h, t)  `wallZ` — a wall running along Z at a constant x
//   stairs(x, y0, z, dir, steps, w) `stairs`
//   rail(x1, z1, x2, z2, y)         `rail`
//
// Walls carry "holes" in the reference's format — [a, b, y0, y1] measured along
// the wall's run — and those holes are the doorways and windows that make its
// buildings enterable. An earlier pass of mine dropped them, which left solid
// boxes with no way in or out; they are the whole reason the map is walkable.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { INK, type InkId, makeInkMaterial, type Collider } from "./world";

export type District = {
  colliders: Collider[];
  spawnPoints: THREE.Vector3[];
  sniperSpots: THREE.Vector3[];
  pickupSpots: THREE.Vector3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** drives the few decorative movers (orbiting paper planes) */
  update: (t: number) => void;
};

/**
 * Street corners known to be open ground, used as the last resort when every
 * hand-placed pad in the district fails its clearance test.
 *
 * A fixed list rather than a search: a player who cannot be placed anywhere
 * sensible should still land on a real piece of pavement instead of wherever
 * the nearest ceiling happens to be. Every point here was checked against the
 * built colliders at the player's body size — re-check them if the map moves.
 */
export const SAFE_SPAWNS: THREE.Vector3[] = [
  new THREE.Vector3(0, 0.2, -48),
  new THREE.Vector3(0, 0.2, 48),
  new THREE.Vector3(-48, 0.2, 0),
  new THREE.Vector3(48, 0.2, 0),
  new THREE.Vector3(-40, 0.2, -40),
  new THREE.Vector3(40, 0.2, 32),
  new THREE.Vector3(-24, 0.2, 24),
  new THREE.Vector3(24, 0.2, -24),
];

/** [start, end, yStart?, yEnd?] along the wall's run; the y pair defaults to the full height */
type Hole = [number, number, number?, number?];
type Opts = { ink?: InkId; fill?: boolean; noCollide?: boolean };
type StepOpts = Opts & { rise?: number; run?: number };

export function buildDistrict(scene: THREE.Object3D): District {
  const colliders: Collider[] = [];
  const spawnPoints: THREE.Vector3[] = [];
  const sniperSpots: THREE.Vector3[] = [];
  const pickupSpots: THREE.Vector3[] = [];
  const B = 55; // half-size of the playfield
  const S = 6; // boundary wall thickness
  const L = 18; // boundary wall height
  const V = B - 3.8;
  const P = B - 3;

  // Like the reference's `finish()`, every piece of map geometry is merged into
  // one mesh per ink — a handful of draw calls instead of several hundred.
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  const addGeo = (g: THREE.BufferGeometry, ink: InkId, fill = false) => {
    const key = `${ink}|${fill ? 1 : 0}`;
    const list = buckets.get(key);
    if (list) list.push(g);
    else buckets.set(key, [g]);
  };

  const box = (cx: number, y0: number, cz: number, w: number, h: number, d: number, o: Opts = {}) => {
    const g = new THREE.BoxGeometry(Math.max(0.001, w), Math.max(0.001, h), Math.max(0.001, d));
    g.translate(cx, y0 + h / 2, cz);
    addGeo(g, o.ink ?? INK.BLUE, o.fill);
    if (!o.noCollide) {
      colliders.push({ minX: cx - w / 2, maxX: cx + w / 2, minY: y0, maxY: y0 + h, minZ: cz - d / 2, maxZ: cz + d / 2 });
    }
  };

  const slab = (x1: number, z1: number, x2: number, z2: number, y: number, t: number, o: Opts = {}) =>
    box((x1 + x2) / 2, y - t, (z1 + z2) / 2, Math.abs(x2 - x1), t, Math.abs(z2 - z1), o);

  // A wall run minus its holes: the solid rectangles that are left. Only runs
  // that line up vertically are joined, exactly as the reference's `c()` does.
  const spans = (min: number, max: number, h: number, holes: Hole[]): [number, number, number, number][] => {
    const cuts = new Set<number>([min, max]);
    for (const hl of holes) {
      cuts.add(Math.min(Math.max(hl[0], min), max));
      cuts.add(Math.min(Math.max(hl[1], min), max));
    }
    const xs = [...cuts].sort((a, b) => a - b);
    const out: [number, number, number, number][] = [];
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i];
      const b = xs[i + 1];
      if (b - a < 0.005) continue;
      const mid = (a + b) / 2;
      const cover: [number, number][] = [];
      for (const hl of holes) {
        if (hl[0] <= mid && hl[1] >= mid) cover.push([hl[2] ?? 0, hl[3] ?? h]);
      }
      cover.sort((p, q) => p[0] - q[0]);
      let top = 0;
      const pieces: [number, number][] = [];
      for (const [s0, s1] of cover) {
        if (s0 > top + 0.005) pieces.push([top, s0]);
        top = Math.max(top, s1);
      }
      if (top < h - 0.005) pieces.push([top, h]);
      for (const [ya, yb] of pieces) {
        const last = out[out.length - 1];
        if (last && Math.abs(last[2] - ya) < 0.005 && Math.abs(last[3] - yb) < 0.005 && Math.abs(last[1] - a) < 0.005) {
          last[1] = b;
        } else {
          out.push([a, b, ya, yb]);
        }
      }
    }
    return out;
  };

  /** wall along X, constant z */
  const wallX = (x0: number, x1: number, z: number, y0: number, h: number, t: number, holes: Hole[] = [], o: Opts = {}) => {
    for (const [a, b, ya, yb] of spans(x0, x1, h, holes)) box((a + b) / 2, y0 + ya, z, b - a, yb - ya, t, o);
  };
  /** wall along Z, constant x */
  const wallZ = (z0: number, z1: number, x: number, y0: number, h: number, t: number, holes: Hole[] = [], o: Opts = {}) => {
    for (const [a, b, ya, yb] of spans(z0, z1, h, holes)) box(x, y0 + ya, (a + b) / 2, t, yb - ya, b - a, o);
  };

  const stairs = (x: number, y0: number, z: number, dir: "+x" | "-x" | "+z" | "-z", steps: number, width: number, o: StepOpts = {}) => {
    const rise = o.rise ?? 0.2857142857142857;
    const run = o.run ?? 0.45;
    const dx = dir === "+x" ? 1 : dir === "-x" ? -1 : 0;
    const dz = dir === "+z" ? 1 : dir === "-z" ? -1 : 0;
    for (let i = 0; i < steps; i++) {
      const j = (i + 0.5) * run;
      const hgt = (i + 1) * rise;
      box(x + dx * j, y0, z + dz * j, dx ? run + 0.004 : width, hgt, dz ? run + 0.004 : width, o);
    }
  };

  const rail = (x1: number, z1: number, x2: number, z2: number, y: number, o: Opts = {}) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const alongX = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    const cx = (x1 + x2) / 2;
    const cz = (z1 + z2) / 2;
    box(cx, y + 0.9, cz, alongX ? len : 0.12, 0.12, alongX ? 0.12 : len, { noCollide: true, ink: o.ink });
    const posts = Math.max(1, Math.round(len / 2));
    for (let i = 0; i <= posts; i++) {
      const k = i / posts;
      box(x1 + (x2 - x1) * k, y, z1 + (z2 - z1) * k, 0.1, 0.9, 0.1, { noCollide: true, ink: o.ink });
    }
    colliders.push(
      alongX
        ? { minX: cx - len / 2, maxX: cx + len / 2, minY: y, maxY: y + 1, minZ: cz - 0.06, maxZ: cz + 0.06 }
        : { minX: cx - 0.06, maxX: cx + 0.06, minY: y, maxY: y + 1, minZ: cz - len / 2, maxZ: cz + len / 2 },
    );
  };

  const cyl = (x: number, y0: number, z: number, r: number, h: number, o: Opts & { seg?: number } = {}) => {
    const g = new THREE.CylinderGeometry(r, r, h, o.seg ?? 12);
    g.translate(x, y0 + h / 2, z);
    addGeo(g, o.ink ?? INK.BLUE, o.fill);
    if (!o.noCollide) {
      const half = r * 0.8;
      colliders.push({ minX: x - half, maxX: x + half, minY: y0, maxY: y0 + h, minZ: z - half, maxZ: z + half });
    }
  };

  const sphere = (x: number, y: number, z: number, r: number, o: { seg?: number; ink?: InkId } = {}) => {
    const g = new THREE.SphereGeometry(r, o.seg ?? 10, o.seg ?? 8);
    g.translate(x, y, z);
    addGeo(g, o.ink ?? INK.BLUE);
  };

  const ring = (x: number, y: number, z: number, axis: "x" | "y" | "z" = "z") => {
    const g = new THREE.TorusGeometry(0.6, 0.1, 8, 20);
    if (axis === "x") g.rotateY(Math.PI / 2);
    else if (axis === "y") g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    addGeo(g, INK.ORANGE);
  };

  const spawn = (x: number, y: number, z: number) => spawnPoints.push(new THREE.Vector3(x, y, z));  const sniper = (x: number, y: number, z: number) => sniperSpots.push(new THREE.Vector3(x, y, z));
  const pickup = (x: number, y: number, z: number) => pickupSpots.push(new THREE.Vector3(x, y, z));

  /* ---------------- ground, boundary walls, sky dome ---------------- */
  box(0, -1, 0, 2 * B + S, 1, 2 * B + S);
  box(0, 0, -B, 2 * B + S, L, S);
  box(0, 0, B, 2 * B + S, L, S);
  box(-B, 0, 0, S, L, 2 * B + S);
  box(B, 0, 0, S, L, 2 * B + S);
  {
    const R = 96;
    const y0 = -22;
    for (let i = 0; i < 6; i++) {
      const g = new THREE.TorusGeometry(R, 0.5, 5, 80, Math.PI);
      g.rotateY((i * Math.PI) / 6);
      g.translate(0, y0, 0);
      addGeo(g, INK.BLUE);
    }
    for (const y of [30, 46, 60, 70]) {
      const r = Math.sqrt(R * R - (y - y0) * (y - y0));
      const g = new THREE.TorusGeometry(r, 0.4, 5, 96);
      g.rotateX(Math.PI / 2);
      g.translate(0, y, 0);
      addGeo(g, INK.BLUE);
    }
  }

  /* ---------------- raised road decks hugging the boundary ---------------- */
  const DECKS: [number, number, number, number][] = [
    [-30, -V, 8, 1.6],
    [30, -V, 8, 1.6],
    [-V, 40, 1.6, 8],
    [V, -10, 1.6, 8],
    [-V, -30, 1.6, 6],
    [V, 35, 1.6, 6],
    [10, V, 8, 1.6],
    [-40, V, 6, 1.6],
  ];
  for (const [x, z, w, d] of DECKS) {
    box(x, 9, z, w, 0.4, d);
    box(x, 5.5, z, w, 0.4, d);
  }

  /* ---------------- boundary gate frames + their spawns ---------------- */
  const gate = (x: number, z: number, alongX: boolean) => {
    if (alongX) {
      box(x - 1.2, 0, z, 0.3, 3.2, 0.5, { ink: INK.BLACK, noCollide: true });
      box(x + 1.2, 0, z, 0.3, 3.2, 0.5, { ink: INK.BLACK, noCollide: true });
      box(x, 3, z, 2.7, 0.3, 0.5, { ink: INK.BLACK, noCollide: true });
    } else {
      box(x, 0, z - 1.2, 0.5, 3.2, 0.3, { ink: INK.BLACK, noCollide: true });
      box(x, 0, z + 1.2, 0.5, 3.2, 0.3, { ink: INK.BLACK, noCollide: true });
      box(x, 3, z, 0.5, 0.3, 2.7, { ink: INK.BLACK, noCollide: true });
    }
  };
  for (const [x, z] of [
    [-P, 0],
    [P, 0],
    [-P, 30],
    [P, -30],
    [-P, -30],
    [P, 30],
  ]) {
    gate(x, z, false);
    spawn(x + (x < 0 ? 1.2 : -1.2), 0, z);
  }
  for (const [x, z] of [
    [0, -P],
    [0, P],
    [-30, P],
    [30, P],
  ]) {
    gate(x, z, true);
    spawn(x, 0, z + (z < 0 ? 1.2 : -1.2));
  }

  /* ---------------- central tower: floors, pillars, rails, fire escape ---------------- */
  for (let n = 1; n <= 4; n++) slab(-7, -7, 7, 7, n * 4, 0.4);
  for (const [x, z] of [
    [-6.6, -6.6],
    [6.6, -6.6],
    [-6.6, 6.6],
    [6.6, 6.6],
    [0, -6.6],
    [0, 6.6],
    [-6.6, 0],
    [6.6, 0],
  ]) {
    box(x, 0, z, 0.8, 16, 0.8);
  }
  for (let n = 1; n <= 3; n++) {
    const y = n * 4;
    rail(-7, 7, -1.5, 7, y);
    rail(1.5, 7, 7, 7, y);
    rail(-7, -7, 7, -7, y);
    rail(7, -7, 7, -6, y);
    rail(7, 0, 7, 7, y);
    rail(-7, -7, -6.5, -7, y);
    rail(3.5, -7, 7, -7, y);
  }
  rail(-5, -7, 7, -7, 16);
  rail(-7, 7, -1.5, 7, 16);
  rail(1.5, 7, 7, 7, 16);
  rail(-7, -7, -7, 7, 16);
  rail(7, -7, 7, 3, 16);
  box(5.5, 16, 5.5, 1, 10, 1);
  box(5.5, 25.2, 5.5, 1.6, 1.4, 1.6, { noCollide: true });
  box(11.5, 25, 5.5, 16, 0.8, 0.8);
  box(1, 25, 5.5, 5, 0.8, 0.8);
  box(-0.5, 23.6, 5.5, 2, 1.6, 1.6);
  box(19, 20.5, 5.5, 0.08, 4.6, 0.08, { ink: INK.BLACK, noCollide: true });
  ring(19, 19.8, 5.5, "x");
  ring(19.5, 24.6, 5.5, "z");
  {
    let y = 0;
    for (let n = 0; n < 4; n++) {
      const dir: "+x" | "-x" = n % 2 === 0 ? "+x" : "-x";
      const sx = dir === "+x" ? -5 : 1.3;
      const sz = n % 2 === 0 ? -8.3 : -10.3;
      stairs(sx, y, sz, dir, 14, 1.8);
      y += 4;
      const lx = dir === "+x" ? 2.4 : -6.1;
      slab(lx - 1.1, -11.4, lx + 1.1, -7, y, 0.4);
      rail(lx - 1.1, -11.4, lx + 1.1, -11.4, y);
    }
  }
  spawn(0, 8, 0);
  spawn(0, 4, 3);
  sniper(0, 16, -3);
  pickup(0, 12, 0);
  pickup(-4, 8, 4);
  pickup(0, 16, 0);

  /* ---------------- NW block: walled floors + fire escape ---------------- */
  for (let n = 1; n <= 3; n++) slab(-43, 4, -25, 20, n * 4, 0.4);
  wallZ(4, 20, -25, 0, 12, 0.4, [[10, 13, 0, 3.2], [6, 9, 5, 7], [14, 17, 5, 7], [6, 9, 9, 11], [14, 17, 9, 11]]);
  wallZ(4, 20, -43, 0, 12, 0.4, [[8, 11, 0, 3.2], [8, 11, 4.5, 7.5], [8, 11, 8.5, 11.5]]);
  wallX(-43, -25, 4, 0, 12, 0.4, [[-36, -33, 0, 3.2], [-40, -37, 5, 7], [-31, -28, 5, 7], [-36, -32, 8.5, 11.5]]);
  wallX(-43, -25, 20, 0, 12, 0.4, [[-36, -32, 0, 3.2], [-31, -27, 0, 3.2], [-42, -39, 0, 3.2], [-37.2, -33.5, 4.05, 7.2], [-36, -32, 8.4, 11.4], [-41, -27, 4.6, 7.6], [-29, -25.5, 8.05, 11.2]]);
  wallX(-43, -25, 12, 0, 4, 0.3, [[-40, -37.5], [-30, -27.5]]);
  wallX(-43, -25, 12, 4, 4, 0.3, [[-36, -32]]);
  wallZ(4, 20, -34, 8, 4, 0.3, [[8, 11], [14, 17]]);
  rail(-43, 4, -37, 4, 12);
  rail(-31, 4, -25, 4, 12);
  rail(-43, 20, -37.4, 20, 12);
  rail(-34.4, 20, -25, 20, 12);
  rail(-43, 4, -43, 20, 12);
  rail(-25, 4, -25, 9, 12);
  rail(-25, 15, -25, 20, 12);
  {
    let y = 0;
    for (let n = 0; n < 3; n++) {
      const dir: "+x" | "-x" = n % 2 === 0 ? "-x" : "+x";
      const sx = dir === "-x" ? -28.5 : -34.8;
      const sz = n % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, sz, dir, 14, 1.8);
      y += 4;
      const lx = dir === "-x" ? -35.9 : -27.4;
      slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
  }
  {
    const armEnd = -7;
    const len = armEnd + 25.2;
    box((armEnd - 25.2) / 2, 11.6, 6, len, 0.4, 2.4, { ink: INK.ORANGE });
    for (let x = 0; x <= Math.floor(len); x++) box(-25 + x, 12, 5, 0.06, 0.02, x % 5 === 0 ? 0.6 : 0.35, { ink: INK.BLACK, noCollide: true });
    rail(-25, 7.2, armEnd, 7.2, 12, { ink: INK.ORANGE });
  }
  spawn(-34, 0, 10);
  spawn(-40, 0, 18);
  sniper(-27, 12, 6);
  pickup(-34, 4, 12);
  pickup(-30, 12, 16);
  pickup(-40, 8, 8);

  /* ---------------- NE block: hall with an atrium + external stairs ---------------- */
  slab(24, 4, 44, 9, 12, 0.4);
  slab(24, 15, 44, 20, 12, 0.4);
  slab(24, 9, 31, 15, 12, 0.4);
  slab(37, 9, 44, 15, 12, 0.4);
  wallZ(4, 20, 24, 0, 12, 0.4, [[10, 14, 0, 3.6], [6, 9, 7, 10], [15, 18, 7, 10]]);
  wallZ(4, 20, 44, 0, 12, 0.4, [[7, 10, 0, 3.2], [14, 17, 0, 3.2], [8, 16, 7, 10]]);
  wallX(24, 44, 4, 0, 12, 0.4, [[32, 36, 0, 3.6], [27, 30, 7, 10], [38, 41, 7, 10]]);
  wallX(24, 44, 20, 0, 12, 0.4, [[26, 29, 0, 3.2], [39, 42, 0, 3.2], [33.5, 36.5, 4.05, 7.2], [25.5, 28.5, 8.05, 11.2], [32, 36, 8, 11]]);
  // first-floor walkway ringing the two-storey atrium, with its interior stairs
  slab(24.4, 4.4, 26, 19.6, 6, 0.3);
  slab(42, 4.4, 43.6, 19.6, 6, 0.3);
  slab(26, 4.4, 42, 6, 6, 0.3);
  slab(26, 18, 42, 19.6, 6, 0.3);
  rail(26, 6, 26, 9, 6);
  rail(26, 15, 26, 17, 6);
  rail(42, 6, 42, 18, 6);
  rail(26, 6, 31, 6, 6);
  rail(37, 6, 42, 6, 6);
  rail(26, 18, 42, 18, 6);
  stairs(26.2, 0, 8.6, "+z", 21, 1.6, { rise: 6 / 21, run: 0.45 });
  box(34, 0, 12, 2.4, 2.4, 2.4);
  box(36.4, 0, 12, 2.4, 1.2, 2.4);
  box(30, 0, 16, 1.6, 1.6, 1.6, { ink: INK.GREEN });
  {
    let y = 0;
    for (let n = 0; n < 3; n++) {
      const dir: "+x" | "-x" = n % 2 === 0 ? "+x" : "-x";
      const sx = dir === "+x" ? 27.5 : 33.8;
      const sz = n % 2 === 0 ? 21.2 : 23.2;
      stairs(sx, y, sz, dir, 14, 1.8);
      y += 4;
      const lx = dir === "+x" ? 34.9 : 26.4;
      slab(lx - 1.1, 20.2, lx + 1.1, 24.4, y, 0.4);
      rail(lx - 1.1, 24.4, lx + 1.1, 24.4, y);
    }
  }
  rail(24, 4, 31, 4, 12);
  rail(37, 4, 44, 4, 12);
  rail(24, 20, 33.4, 20, 12);
  rail(36.4, 20, 44, 20, 12);
  rail(44, 4, 44, 20, 12);
  rail(24, 4, 24, 9, 12);
  rail(24, 15, 24, 20, 12);
  // roof bridge between the two blocks, with its handrail
  box(15.5, 11.6, 6, 17.4, 0.4, 2.2);
  rail(7, 4.9, 24, 4.9, 12);
  spawn(34, 12, 18);
  spawn(40, 0, 8);
  sniper(26, 12, 18);
  pickup(34, 0, 12);
  pickup(34, 6, 19);
  pickup(42, 12, 6);

  /* ---------------- elevated road across the map (z = -30) ---------------- */
  slab(-52, -34.5, 52, -25.5, 7, 0.6);
  wallX(-52, 52, -34.3, 7, 0.9, 0.4, [[-33, -29], [27, 31], [-2, 2]]);
  wallX(-52, 52, -25.7, 7, 0.9, 0.4, [[-36.5, -33], [33, 36.5]]);
  for (let x = -48; x <= 48; x += 12) box(x, 0, -30, 1.4, 6.4, 1.4);
  stairs(-46.5, 0, -24.5, "+x", 25, 2, { rise: 0.28, run: 0.45 });
  stairs(46.5, 0, -24.5, "-x", 25, 2, { rise: 0.28, run: 0.45 });
  for (let x = -50; x < 50; x += 4) box(x + 1, 7, -30, 2, 0.02, 0.2, { ink: INK.BLACK, noCollide: true });
  spawn(-46, 0, -30);
  spawn(46, 0, -30);
  sniper(0, 7, -30);
  pickup(-10, 7, -30);
  pickup(24, 7, -30);

  /* ---------------- south warehouses, roof stairs, water tank ---------------- */
  box(-30, 0, -45, 14, 7, 10);
  box(-8, 0, -45, 14, 11, 10);
  box(16, 0, -45, 14, 7, 10);
  box(-31, 6.7, -37.25, 2.6, 0.3, 5.5);
  box(29, 6.7, -37.25, 2.6, 0.3, 5.5);
  box(0, 6.7, -37.25, 2.6, 0.3, 5.5);
  rail(-32.3, -40, -32.3, -34.5, 7);
  rail(-29.7, -40, -29.7, -34.5, 7);
  rail(27.7, -40, 27.7, -34.5, 7);
  rail(30.3, -40, 30.3, -34.5, 7);
  stairs(-23, 7, -45, "+x", 14, 2.2);
  slab(-16.9, -46.1, -15, -43.9, 11, 0.4);
  stairs(9, 7, -45, "-x", 14, 2.2);
  slab(-1, -46.1, 2.9, -43.9, 11, 0.4);
  box(-33, 7, -48, 1.2, 1.6, 1.2);
  box(19, 7, -42, 1.2, 1.4, 1.2);
  cyl(-10, 11, -47.5, 1.4, 2.6, { seg: 14 });
  box(-5, 11, -42, 0.1, 4, 0.1, { ink: INK.BLACK, noCollide: true });
  spawn(-8, 0, -37);
  spawn(-30, 0, -37);
  spawn(16, 0, -37);
  sniper(-8, 11, -48);
  sniper(16, 7, -43);
  pickup(-8, 11, -43);
  pickup(-30, 7, -45);

  /* ---------------- plaza: truck, crates, silo, fountain, wash line ---------------- */
  box(-14, 0, 34, 2.5, 2.6, 6.2, { ink: INK.GREEN });
  box(-14, 2.6, 34, 2.5, 2.6, 6.2, { ink: INK.ORANGE });
  box(14, 0, 36, 6.2, 2.6, 2.5);
  box(17, 2.6, 36, 3, 2.6, 2.5, { ink: INK.GREEN });
  box(-6, 0, 28, 1.4, 1.4, 1.4);
  box(-4.5, 0, 28.5, 1.2, 1.2, 1.2);
  box(-5.3, 1.4, 28.2, 1, 1, 1);
  box(8, 0, 26, 1.6, 1.6, 1.6);
  box(9.6, 0, 26.4, 1.2, 1.2, 1.2);
  box(24, 0.6, 40, 11, 3.2, 2.8);
  box(24, 0, 40, 10, 0.6, 2.6, { noCollide: true });
  for (const x of [20, 28]) {
    cyl(x, 0, 41.5, 0.55, 0.4, { seg: 10, ink: INK.BLACK, noCollide: true });
    cyl(x, 0, 38.5, 0.55, 0.4, { seg: 10, ink: INK.BLACK, noCollide: true });
  }
  {
    const silo = new THREE.CylinderGeometry(0.8, 0.8, 16, 6);
    silo.rotateZ(Math.PI / 2);
    silo.translate(-30, 0.8, 44);
    addGeo(silo, INK.ORANGE);
    colliders.push({ minX: -38, maxX: -22, minY: 0, maxY: 1.6, minZ: 43.2, maxZ: 44.8 });
    const nose = new THREE.ConeGeometry(0.8, 2.4, 6);
    nose.rotateZ(-Math.PI / 2);
    nose.translate(-20.8, 0.8, 44);
    addGeo(nose, INK.BLACK);
    colliders.push({ minX: -22, maxX: -19.6, minY: 0, maxY: 1.6, minZ: 43.2, maxZ: 44.8 });
    const cap = new THREE.CylinderGeometry(0.82, 0.82, 1.6, 8);
    cap.rotateZ(Math.PI / 2);
    cap.translate(-38.8, 0.8, 44);
    addGeo(cap, INK.PINK);
    colliders.push({ minX: -39.6, maxX: -38, minY: 0, maxY: 1.64, minZ: 43.2, maxZ: 44.8 });
  }
  box(38, 0, 40, 6, 2.2, 3.2, { ink: INK.PINK });
  box(38, 2.2, 40, 6, 0.8, 3.2, { ink: INK.BLUE });
  cyl(-40, 0, 32, 2.6, 3.4, { seg: 16, ink: INK.BLACK });
  {
    const basin = new THREE.TorusGeometry(1.4, 0.35, 8, 16);
    basin.translate(-36.6, 1.8, 32);
    addGeo(basin, INK.BLUE);
  }
  for (const [x, z] of [[-10, 46], [10, 46], [-22, 24], [22, 24]] as const) {
    box(x, 0, z, 0.25, 6, 0.25);
    box(x, 6, z, 1.4, 0.3, 0.5, { noCollide: true });
  }
  for (const [x, z] of [[-4, 46], [4, 46]] as const) {
    box(x, 0.4, z, 3, 0.15, 0.6);
    box(x, 0, z, 2.6, 0.4, 0.2, { noCollide: true });
  }
  pickup(-6, 0, 36);
  pickup(6, 0, 36);
  pickup(-30, 1.6, 44);
  pickup(38, 3, 40);
  pickup(0, 0, 10);

  /* ------------------------------------------------------------------ *
   * WEST WORKS — a two-storey workshop you can fight through, with a
   * walkable roof. Footprint x -45..-27, z -22..-6.
   * ------------------------------------------------------------------ */
  slab(-45, -22, -27, -6, 9, 0.4); // roof plate
  slab(-45, -22, -27, -6, 4.5, 0.35); // mezzanine floor
  wallX(-45, -27, -22, 0, 9, 0.4, [[-40, -36, 0, 3.6], [-33, -29, 0, 3.6]]);
  wallX(-45, -27, -6, 0, 9, 0.4, [[-38, -34, 0, 3.6], [-31, -27, 4.6, 8.2]]);
  wallZ(-22, -6, -45, 0, 9, 0.4, [[-19, -15, 0, 3.6], [-13, -9, 4.6, 8.2]]);
  wallZ(-22, -6, -27, 0, 9, 0.4, [[-19, -15, 0, 3.6], [-13, -9, 4.6, 8.2]]);
  wallZ(-22, -6, -36, 0, 4.5, 0.3, [[-19, -16, 0, 3.2]]); // interior partition
  // mezzanine stair in the west bay
  stairs(-44, 0, -9, "-z", 16, 1.8, { rise: 4.5 / 16, run: 0.45 });
  // roof stair climbing the east face, outside the wall
  stairs(-25.8, 0, -7.4, "-z", 32, 2, { rise: 0.28125, run: 0.45 });
  slab(-27, -22.4, -24.6, -21.2, 9, 0.4);
  // roof rails with gaps, a tank and vents
  rail(-45, -22, -45, -14, 9);
  rail(-45, -12, -45, -6, 9);
  rail(-45, -6, -34, -6, 9);
  rail(-30, -6, -27, -6, 9);
  rail(-45, -22, -34, -22, 9);
  cyl(-40, 9, -12, 1.5, 2.4, { seg: 12 });
  box(-31, 9, -18, 1.6, 1.4, 1.6, { ink: INK.ORANGE });
  box(-30, 9, -10, 2.2, 1, 2.2, { ink: INK.BLACK });
  // the yard outside: stacked containers on a loading dock
  slab(-45, -6, -27, -2.2, 1.2, 0.4);
  box(-31, 1.2, -4, 6, 2.6, 2.6, { ink: INK.GREEN });
  box(-31, 3.8, -3.7, 5.4, 2.4, 2.4, { ink: INK.ORANGE });
  box(-38, 0, -3.4, 2.4, 1.2, 2.4, { ink: INK.BLUE });
  spawn(-41, 0, -18);
  spawn(-34, 0, -9);
  spawn(-31, 0, -12);
  sniper(-40, 9, -12);
  sniper(-30, 9, -20);
  pickup(-36, 0, -12);
  pickup(-44, 4.5, -8);
  pickup(-40, 9, -10);

  /* ------------------------------------------------------------------ *
   * EAST DECK — an open two-level car park: a covered garage under two
   * decks, joined by internal stairs. Footprint x 26..46, z -22..-6.
   * ------------------------------------------------------------------ */
  for (const x of [28.5, 33.5, 38.5, 43.5]) {
    for (const z of [-20.5, -15.5, -10.5]) box(x, 0, z, 0.9, 4.2, 0.9, { ink: INK.BLACK });
  }
  // deck 1, built as four plates around a stairwell opening
  slab(26, -22, 28, -6, 4.2, 0.4);
  slab(34, -22, 46, -6, 4.2, 0.4);
  slab(28, -22, 34, -16, 4.2, 0.4);
  slab(28, -13, 34, -6, 4.2, 0.4);
  stairs(31, 0, -21.6, "+z", 15, 3, { rise: 0.28, run: 0.5 });
  // deck 2, half the footprint, with its own opening
  slab(26, -14, 40, -6, 8.4, 0.4);
  slab(44, -14, 46, -6, 8.4, 0.4);
  slab(40, -14, 44, -11, 8.4, 0.4);
  slab(40, -8, 44, -6, 8.4, 0.4);
  stairs(42, 4.2, -13.6, "+z", 15, 3, { rise: 0.28, run: 0.5 });
  // kerbs along the open edges
  box(36, 4.2, -22, 20, 0.5, 0.4, { ink: INK.BLACK });
  box(36, 4.2, -6, 20, 0.5, 0.4, { ink: INK.BLACK });
  box(46, 4.2, -14, 0.4, 0.5, 16, { ink: INK.BLACK });
  box(26, 4.2, -14, 0.4, 0.5, 16, { ink: INK.BLACK });
  box(33, 8.4, -6, 14, 0.5, 0.4, { ink: INK.BLACK });
  box(46, 8.4, -10, 0.4, 0.5, 8, { ink: INK.BLACK });
  box(26, 8.4, -10, 0.4, 0.5, 8, { ink: INK.BLACK });
  // parked wrecks and a barrier or two for cover
  box(38, 4.2, -19, 4.4, 1.3, 2.1, { ink: INK.PINK });
  box(38, 5.5, -19, 2.4, 0.9, 1.9, { ink: INK.PINK });
  box(30, 4.2, -9, 4.4, 1.3, 2.1, { ink: INK.BLUE });
  box(30, 5.5, -9, 2.4, 0.9, 1.9, { ink: INK.BLUE });
  box(40, 0, -19, 4, 1.05, 0.6, { ink: INK.BLACK });
  box(28, 0, -8, 4, 1.05, 0.6, { ink: INK.BLACK });
  spawn(31, 0, -10);
  spawn(44, 0, -8);
  spawn(36, 0, -13);
  sniper(44, 8.4, -8);
  sniper(27, 8.4, -13);
  pickup(30, 0, -20);
  pickup(45, 4.2, -18);
  pickup(32, 8.4, -7);

  /* ------------------------------------------------------------------ *
   * SKYWAYS — high routes leaving the tower's second floor east and
   * west, each ending in a stair down to the street.
   * ------------------------------------------------------------------ */
  slab(7, -5.5, 19, -1.5, 8, 0.35);
  slab(17, -8.2, 23.5, -1.5, 8, 0.35);
  rail(7, -1.5, 23.5, -1.5, 8);
  rail(7, -5.5, 17, -5.5, 8);
  rail(17, -8.2, 20.2, -8.2, 8);
  rail(22.8, -8.2, 23.5, -8.2, 8);
  rail(23.5, -8.2, 23.5, -1.5, 8);
  stairs(21.5, 0, -16.4, "+z", 16, 2.4, { rise: 0.5, run: 0.45 });
  slab(20.3, -9.6, 22.7, -8, 8, 0.4);

  slab(-19, -5.5, -7, -1.5, 8, 0.35);
  slab(-23.5, -8.2, -17, -1.5, 8, 0.35);
  rail(-23.5, -1.5, -7, -1.5, 8);
  rail(-17, -5.5, -7, -5.5, 8);
  rail(-20.2, -8.2, -17, -8.2, 8);
  rail(-23.5, -8.2, -22.8, -8.2, 8);
  rail(-23.5, -8.2, -23.5, -1.5, 8);
  stairs(-21.5, 0, -16.4, "+z", 16, 2.4, { rise: 0.5, run: 0.45 });
  slab(-22.7, -9.6, -20.3, -8, 8, 0.4);
  spawn(18, 0, -16);
  spawn(-18, 0, -13);
  pickup(11, 8, -3.5);
  pickup(-11, 8, -3.5);

  /* ------------------------------------------------------------------ *
   * STREET COVER — the south street was the emptiest, most exposed part
   * of the map. Barriers, a low wall and a bus shelter give it lanes.
   * ------------------------------------------------------------------ */
  for (const x of [-12, -8.4, -4.8, 8, 11.6, 15.2]) box(x, 0, 24, 3.2, 1.05, 0.6, { ink: INK.BLACK });
  box(-4, 0, 20, 14, 1.1, 0.5);
  box(10.2, 0, 29, 0.2, 2.6, 0.2, { ink: INK.BLACK });
  box(13.8, 0, 29, 0.2, 2.6, 0.2, { ink: INK.BLACK });
  box(12, 2.6, 29, 4.4, 0.25, 2.8, { ink: INK.GREEN, noCollide: true });
  box(12, 0, 29, 4, 0.5, 0.3, { ink: INK.BLUE });
  box(-18, 0, 18, 2.6, 1.6, 1.6, { ink: INK.ORANGE });
  box(18, 0, 18, 2.6, 1.6, 1.6, { ink: INK.ORANGE });
  for (const x of [-20, -12, 12, 20]) box(x, 7, -30, 3.4, 1.05, 0.6, { ink: INK.BLACK });
  spawn(-10, 0, 22);
  spawn(13, 0, 26);
  spawn(0, 0, 26);
  spawn(-14, 0, 12);
  spawn(14, 0, 12);
  pickup(-12, 0, 24);
  pickup(12, 0, 27);

  /* ---------------- street clutter ---------------- */
  box(-16, 0, -8, 2.2, 1.2, 2.2);
  box(18, 0, -10, 2.2, 1.6, 2.2);
  box(-20, 0, 8, 1.6, 1, 3);
  box(20, 0, -2, 3, 1, 1.6);
  box(-8, 0, -18, 4, 1.1, 1.2);
  box(8, 0, -18, 4, 1.1, 1.2);
  box(0, 0, 22, 5, 0.5, 1.4);
  box(-24, 0, -18, 2.4, 2.6, 2.4, { ink: INK.ORANGE });
  box(26, 0, -18, 2.4, 2.6, 2.4, { ink: INK.GREEN });

  /* ---------------- decor beyond the walls ---------------- */
  sphere(-90, 110, -160, 12, { seg: 12 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const g = new THREE.BoxGeometry(6, 0.7, 0.7);
    g.rotateZ(a);
    g.translate(-90 + Math.cos(a) * 19, 110 + Math.sin(a) * 19, -160);
    addGeo(g, INK.BLUE);
  }
  for (const [x, y, z, k] of [
    [60, 70, -170, 1],
    [-20, 75, -190, 1.3],
    [140, 60, -80, 0.9],
    [-150, 65, 40, 1.1],
    [30, 80, 180, 1.2],
    [-90, 60, 170, 0.8],
  ] as const) {
    for (let n = 0; n < 6; n++) sphere(x + (n - 2.5) * 5 * k, y + Math.sin(n * 1.7) * 2.5 * k, z, (4 + (n % 3)) * k, { seg: 10 });
  }

  // three paper planes drifting over the district (the reference's orbiting cones)
  const movers: { mesh: THREE.Mesh; radius: number; height: number; phase: number; speed: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const scale = 1.4;
    const g = new THREE.ConeGeometry(1.2 * scale, 4 * scale, 3);
    g.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(g, makeInkMaterial(INK.BLUE));
    scene.add(mesh);
    movers.push({ mesh, radius: 30 + i * (8 * scale), height: 30 + i * (6 * scale), phase: i * 2.1, speed: 0.11 + i * 0.01 });
  }
  const update = (t: number) => {
    for (const m of movers) {
      const w = t * m.speed + m.phase;
      const r = m.radius;
      m.mesh.position.set(Math.cos(w) * r, m.height + Math.sin(w * 2.3) * 3, Math.sin(w) * r * 0.7);
      m.mesh.lookAt(Math.cos(w + 0.05) * r, m.height + Math.sin((w + 0.05) * 2.3) * 3, Math.sin(w + 0.05) * r * 0.7);
      m.mesh.rotateZ(Math.sin(w * 3) * 0.6);
    }
  };
  update(0);

  /* ---------------- bake: one mesh per ink ---------------- */
  for (const [key, list] of buckets) {
    const [inkStr, fillStr] = key.split("|");
    const merged = mergeGeometries(list, false);
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, makeInkMaterial(Number(inkStr) as InkId, fillStr === "1"));
    mesh.frustumCulled = false;
    scene.add(mesh);
    for (const g of list) g.dispose();
  }

  return {
    colliders,
    spawnPoints,
    sniperSpots,
    pickupSpots,
    bounds: { minX: -B, maxX: B, minZ: -B, maxZ: B },
    update,
  };
}
