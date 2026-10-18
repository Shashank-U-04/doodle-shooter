// ANCIENT EGYPT — The Pharaoh's Valley.
//
// Three connected areas, each built as its own group at its own floor height:
//
//   surface  (y = 0)      open desert: the great pyramid, two smaller pyramids,
//                         temple, sphinx, obelisks, ruins, market, oasis and a
//                         dry canyon cut into the western cliffs
//   interior (y = -140)   the Forgotten Sanctuary inside the great pyramid:
//                         a carved chamber, columns, side chapel and the
//                         concealed floor hatch that leads down
//   tomb     (y = -300)   the Cursed Tomb: burial chambers, a treasure vault,
//                         a pharaoh's room, a secret vault, sealed doors,
//                         sarcophagi, a pressure plate and spike pits
//
// Only one area is live at a time: the engine swaps in that zone's colliders,
// bounds, floor height, spawn points and palette, and hides the other two
// groups. That is what keeps an underground room from costing anything while
// you cross the dunes — and it is why the tomb can be dark without making the
// desert dusk.
//
// Everything visible is merged per (ink, fill) exactly like the district builder,
// so a zone costs a handful of draw calls rather than thousands. Only structural
// geometry joins the collider list; glyphs, torch brackets and gold piles are
// decoration and stay out of the physics loop.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { INK, makeInkMaterial, type Collider, type InkId } from "./world";

export type ZoneId = "surface" | "interior" | "tomb";

export type Mood = {
  /** paper colour behind the hatching — the scene's ambient light */
  paper: [number, number, number];
  /** 0 = ink on paper, 1 = chalk on a dark tomb wall */
  chalk: number;
  /** 0 ruled notebook, 1 graph paper, 2 no ruling */
  lines: number;
  background: number;
};

export type EgyptZone = {
  id: ZoneId;
  title: string;
  sub: string;
  group: THREE.Group;
  colliders: Collider[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  floorY: number;
  spawnPoints: THREE.Vector3[];
  /** where a fresh body is put on entering this area */
  start: THREE.Vector3;
  startYaw: number;
  mood: Mood;
  /** mummies already standing in the room, waiting to notice you */
  dormant: { pos: THREE.Vector3; yaw: number }[];
};

export type Loot = { health?: number; ammo?: number; grenades?: number; score?: number };

export type Outcome = {
  tip?: string;
  loot?: Loot;
  /** places to raise a mummy from */
  awaken?: THREE.Vector3[];
  travel?: { zone: ZoneId; x: number; y: number; z: number; yaw: number };
  sound?: "door" | "chest" | "stone" | "mummy";
};

export type Prompt = { id: string; label: string };

type Interaction = {
  id: string;
  pos: THREE.Vector3;
  radius: number;
  label: () => string | null;
  run: () => Outcome | null;
};

type Bucket = { ink: InkId; fill: boolean; geos: THREE.BufferGeometry[] };

type Slide = {
  obj: THREE.Object3D;
  base: THREE.Vector3;
  dir: THREE.Vector3;
  dist: number;
  open: () => boolean;
  collider?: Collider;
  owner?: Collider[];
  colliderLive: boolean;
  k: number;
};

/* ============================== builder ============================== */

/**
 * One area's geometry, colliders and spawn pads.
 *
 * Every coordinate handed to a helper is *local* to the zone: y = 0 is the
 * floor and the origin is the middle of the map. The floor offset is applied
 * once, when the geometry is baked, so a room can be authored the same way at
 * any depth.
 */
class Zone {
  readonly group = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly spawns: THREE.Vector3[] = [];
  private buckets = new Map<string, Bucket>();
  readonly baseY: number;

  constructor(baseY: number) {
    this.baseY = baseY;
  }

  addGeo(geo: THREE.BufferGeometry, ink: InkId, fill = false) {
    const key = `${ink}|${fill ? 1 : 0}`;
    const found = this.buckets.get(key);
    if (found) found.geos.push(geo);
    else this.buckets.set(key, { ink, fill, geos: [geo] });
  }

  /** a box whose bottom face sits at local height `y` */
  box(cx: number, y: number, cz: number, w: number, h: number, d: number, ink: InkId, fill = false, collide = true) {
    const ww = Math.max(0.01, w);
    const hh = Math.max(0.01, h);
    const dd = Math.max(0.01, d);
    const geo = new THREE.BoxGeometry(ww, hh, dd);
    geo.translate(cx, this.baseY + y + hh / 2, cz);
    this.addGeo(geo, ink, fill);
    if (collide) {
      this.colliders.push({
        minX: cx - ww / 2,
        maxX: cx + ww / 2,
        minY: this.baseY + y,
        maxY: this.baseY + y + hh,
        minZ: cz - dd / 2,
        maxZ: cz + dd / 2,
      });
    }
  }

  /** a floor/roof plate between two corners with its top at `yTop` */
  slab(x1: number, z1: number, x2: number, z2: number, yTop: number, thick: number, ink: InkId, collide = true) {
    this.box((x1 + x2) / 2, yTop - thick, (z1 + z2) / 2, Math.abs(x2 - x1), thick, Math.abs(z2 - z1), ink, false, collide);
  }

  /** wall along X at a constant z, minus door holes ([a,b,y0,y1] along the run) */
  wallX(
    x0: number,
    x1: number,
    z: number,
    y0: number,
    h: number,
    t: number,
    holes: [number, number, number?, number?][] = [],
    ink: InkId = INK.STONE,
  ) {
    this.wallRun("x", x0, x1, z, y0, h, t, holes, ink);
  }

  /** wall along Z at a constant x */
  wallZ(
    z0: number,
    z1: number,
    x: number,
    y0: number,
    h: number,
    t: number,
    holes: [number, number, number?, number?][] = [],
    ink: InkId = INK.STONE,
  ) {
    this.wallRun("z", z0, z1, x, y0, h, t, holes, ink);
  }

  private wallRun(
    axis: "x" | "z",
    a0: number,
    a1: number,
    fixed: number,
    y0: number,
    h: number,
    t: number,
    holes: [number, number, number?, number?][],
    ink: InkId,
  ) {
    // Split the run at every hole edge, then cut each slice into solid spans.
    const cuts = new Set<number>([a0, a1]);
    for (const hl of holes) {
      cuts.add(Math.min(Math.max(hl[0], a0), a1));
      cuts.add(Math.min(Math.max(hl[1], a0), a1));
    }
    const xs = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i];
      const b = xs[i + 1];
      if (b - a < 0.01) continue;
      const mid = (a + b) / 2;
      const cover: [number, number][] = [];
      for (const hl of holes) if (hl[0] <= mid && hl[1] >= mid) cover.push([hl[2] ?? 0, hl[3] ?? h]);
      cover.sort((p, q) => p[0] - q[0]);
      let top = 0;
      const pieces: [number, number][] = [];
      for (const [s0, s1] of cover) {
        if (s0 > top + 0.01) pieces.push([top, s0]);
        top = Math.max(top, s1);
      }
      if (top < h - 0.01) pieces.push([top, h]);
      for (const [ya, yb] of pieces) {
        if (yb - ya < 0.01) continue;
        if (axis === "x") this.box(mid, y0 + ya, fixed, b - a, yb - ya, t, ink);
        else this.box(fixed, y0 + ya, mid, t, yb - ya, b - a, ink);
      }
    }
  }

  stairs(x: number, y0: number, z: number, dir: "+x" | "-x" | "+z" | "-z", steps: number, width: number, rise: number, run: number, ink: InkId = INK.OCHRE) {
    const dx = dir === "+x" ? 1 : dir === "-x" ? -1 : 0;
    const dz = dir === "+z" ? 1 : dir === "-z" ? -1 : 0;
    for (let i = 0; i < steps; i++) {
      const j = (i + 0.5) * run;
      this.box(x + dx * j, y0, z + dz * j, dx ? run + 0.004 : width, (i + 1) * rise, dz ? run + 0.004 : width, ink);
    }
  }

  cyl(x: number, y: number, z: number, r: number, h: number, ink: InkId, fill = false, collide = true, seg = 12) {
    const geo = new THREE.CylinderGeometry(r, r, Math.max(0.01, h), seg);
    geo.translate(x, this.baseY + y + h / 2, z);
    this.addGeo(geo, ink, fill);
    if (collide) {
      const half = r * 0.82;
      this.colliders.push({ minX: x - half, maxX: x + half, minY: this.baseY + y, maxY: this.baseY + y + h, minZ: z - half, maxZ: z + half });
    }
  }

  taper(x: number, y: number, z: number, rBottom: number, rTop: number, h: number, ink: InkId, seg = 4, fill = false, collide = true) {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, Math.max(0.01, h), seg);
    geo.translate(x, this.baseY + y + h / 2, z);
    this.addGeo(geo, ink, fill);
    if (collide) {
      const half = Math.max(rBottom, rTop) * 0.72;
      this.colliders.push({ minX: x - half, maxX: x + half, minY: this.baseY + y, maxY: this.baseY + y + h, minZ: z - half, maxZ: z + half });
    }
  }

  sphere(x: number, y: number, z: number, r: number, ink: InkId, fill = false, sy = 1, seg = 10) {
    const geo = new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.7)));
    geo.scale(1, sy, 1);
    geo.translate(x, this.baseY + y, z);
    this.addGeo(geo, ink, fill);
  }

  /**
   * A half-buried dune: a squashed upper hemisphere you can climb over.
   *
   * The smooth mound is the drawing; the physics is a short flight of steps
   * hidden inside it. Without them the mound would be a ghost you walk
   * through — back-face culling makes it vanish the moment you are inside it.
   */
  dune(x: number, z: number, r: number, height: number) {
    const geo = new THREE.SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    geo.scale(1, height / r, 0.78);
    geo.translate(x, this.baseY, z);
    this.addGeo(geo, INK.SAND);
    const steps = Math.max(3, Math.ceil(height / 0.48));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const f = Math.sqrt(Math.max(0, 1 - t * t));
      this.collide(x, 0, z, 2 * r * f, height * t, 2 * r * f * 0.78);
    }
  }

  /** a flat disc lying on the floor */
  disc(x: number, y: number, z: number, r: number, ink: InkId, fill = true, seg = 20) {
    const geo = new THREE.CircleGeometry(r, seg);
    geo.rotateX(-Math.PI / 2);
    geo.translate(x, this.baseY + y, z);
    this.addGeo(geo, ink, fill);
  }

  ring(x: number, y: number, z: number, r: number, tube: number, ink: InkId, fill = true) {
    const geo = new THREE.TorusGeometry(r, tube, 5, 18);
    geo.rotateX(Math.PI / 2);
    geo.translate(x, this.baseY + y, z);
    this.addGeo(geo, ink, fill);
  }

  /** a band of hieroglyphic marks, cut as tiny raised blocks on a wall face */
  glyphs(x: number, y: number, z: number, along: "x" | "z", width: number, height: number, rows = 2) {
    const cols = Math.max(3, Math.floor(width / 0.7));
    const border = 0.16;
    if (along === "x") {
      this.box(x, y, z - 0.03, width + border * 2, height + border * 2, 0.05, INK.OCHRE, false, false);
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < cols; i++) {
          const f = Math.abs(Math.sin(i * 12.9898 + r * 78.233) * 43758.5453) % 1;
          const cellW = width / cols;
          const gx = x - width / 2 + cellW * (i + 0.5);
          const gy = y + border + ((height - border * 2) / rows) * (r + 0.5);
          const gw = cellW * (0.28 + f * 0.36);
          const gh = ((height - border * 2) / rows) * (0.24 + f * 0.4);
          this.box(gx, gy - gh / 2, z + 0.015, gw, gh, 0.04, f > 0.72 ? INK.TURQ : INK.STONE, false, false);
          if (f > 0.4) this.box(gx, gy + gh * 0.35, z + 0.02, cellW * 0.55, 0.035, 0.035, INK.GOLD, false, false);
        }
      }
    } else {
      this.box(x - 0.03, y, z, 0.05, height + border * 2, width + border * 2, INK.OCHRE, false, false);
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < cols; i++) {
          const f = Math.abs(Math.sin(i * 31.19 + r * 17.77) * 24634.6345) % 1;
          const cellD = width / cols;
          const gz = z - width / 2 + cellD * (i + 0.5);
          const gy = y + border + ((height - border * 2) / rows) * (r + 0.5);
          const gd = cellD * (0.28 + f * 0.36);
          const gh = ((height - border * 2) / rows) * (0.24 + f * 0.4);
          this.box(x + 0.015, gy - gh / 2, gz, 0.04, gh, gd, f > 0.72 ? INK.TURQ : INK.STONE, false, false);
          if (f > 0.4) this.box(x + 0.02, gy + gh * 0.35, gz, 0.035, 0.035, cellD * 0.55, INK.GOLD, false, false);
        }
      }
    }
  }

  /** one manual collider, for statues and other composite props */
  collide(cx: number, y: number, cz: number, w: number, h: number, d: number) {
    this.colliders.push({
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minY: this.baseY + y,
      maxY: this.baseY + y + h,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
    });
  }

  /** free-standing mesh (doors, lids, levers) that has to move on its own */
  mesh(w: number, h: number, d: number, ink: InkId, x: number, y: number, z: number, fill = false) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makeInkMaterial(ink, fill));
    m.position.set(x, this.baseY + y + h / 2, z);
    this.group.add(m);
    return m;
  }

  flush() {
    for (const { ink, fill, geos } of this.buckets.values()) {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, makeInkMaterial(ink, fill));
      mesh.frustumCulled = false;
      this.group.add(mesh);
      if (merged !== geos[0]) for (const g of geos) g.dispose();
    }
    this.buckets.clear();
  }
}

/* ============================== props ============================== */

type Flames = { flame: THREE.Mesh; glow: THREE.Mesh; phase: number };

function torch(z: Zone, x: number, y: number, zz: number, flames: Flames[]) {
  z.box(x, y, zz, 0.2, 0.2, 0.2, INK.STONE, false, false);
  z.cyl(x, y, zz, 0.1, 0.7, INK.OCHRE, true, false, 6);
  z.cyl(x, y + 0.66, zz, 0.24, 0.16, INK.GOLD, true, false, 8);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), makeInkMaterial(INK.GOLD, true));
  flame.position.set(x, z.baseY + y + 1.0, zz);
  flame.scale.set(0.8, 1.5, 0.8);
  z.group.add(flame);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), makeInkMaterial(INK.ORANGE, true));
  glow.position.set(x, z.baseY + y + 1.0, zz);
  glow.scale.set(1, 1.2, 1);
  z.group.add(glow);
  flames.push({ flame, glow, phase: x * 0.7 + zz * 0.3 });
}

function anubis(z: Zone, x: number, zz: number, s = 1, y = 0) {
  z.box(x, y, zz, 2.2 * s, 0.5 * s, 2.2 * s, INK.STONE, false, false);
  z.box(x, y + 0.5 * s, zz, 1.5 * s, 2.3 * s, 1.05 * s, INK.BLACK, false, false);
  z.box(x, y + 0.62 * s, zz, 1.56 * s, 0.45 * s, 1.1 * s, INK.GOLD, true, false);
  z.box(x, y + 2.15 * s, zz, 1.4 * s, 0.34 * s, 1.0 * s, INK.TURQ, true, false);
  z.box(x, y + 1.6 * s, zz + 0.58 * s, 1.5 * s, 0.2 * s, 0.2 * s, INK.GOLD, true, false);
  z.box(x, y + 1.85 * s, zz + 0.6 * s, 1.15 * s, 0.2 * s, 0.2 * s, INK.GOLD, true, false);
  z.box(x + 1.03 * s, y + 0.5 * s, zz + 0.6 * s, 0.11 * s, 3.5 * s, 0.11 * s, INK.GOLD, false, false);
  // jackal head: skull, long snout, tall ears
  z.box(x, y + 2.6 * s, zz + 0.05 * s, 0.72 * s, 0.78 * s, 0.72 * s, INK.BLACK, false, false);
  z.box(x, y + 2.7 * s, zz + 0.57 * s, 0.32 * s, 0.3 * s, 0.62 * s, INK.BLACK, false, false);
  z.box(x - 0.27 * s, y + 3.3 * s, zz - 0.02 * s, 0.17 * s, 0.8 * s, 0.18 * s, INK.BLACK, false, false);
  z.box(x + 0.27 * s, y + 3.3 * s, zz - 0.02 * s, 0.17 * s, 0.8 * s, 0.18 * s, INK.BLACK, false, false);
  z.box(x - 0.18 * s, y + 2.9 * s, zz + 0.42 * s, 0.12 * s, 0.09 * s, 0.04 * s, INK.GOLD, true, false);
  z.box(x + 0.18 * s, y + 2.9 * s, zz + 0.42 * s, 0.12 * s, 0.09 * s, 0.04 * s, INK.GOLD, true, false);
  z.collide(x, y, zz, 2.2 * s, 3.6 * s, 2.2 * s);
}

function sphinx(z: Zone, x: number, zz: number) {
  z.box(x, 0, zz, 13, 0.7, 8, INK.STONE);
  z.box(x, 0.7, zz - 0.4, 9.4, 3.2, 4.2, INK.SAND, false, false);
  z.box(x, 0.7, zz - 2.2, 5.2, 2.5, 3.2, INK.OCHRE, false, false);
  // forelegs stretched toward the player, paws apart
  z.box(x - 1.9, 0.7, zz + 2.6, 1.5, 1.25, 5.4, INK.SAND, false, false);
  z.box(x + 1.9, 0.7, zz + 2.6, 1.5, 1.25, 5.4, INK.SAND, false, false);
  z.box(x - 1.9, 0.7, zz + 5.5, 1.8, 0.85, 1.8, INK.OCHRE, false, false);
  z.box(x + 1.9, 0.7, zz + 5.5, 1.8, 0.85, 1.8, INK.OCHRE, false, false);
  z.box(x + 4.4, 1.4, zz - 1.6, 0.7, 0.7, 3.2, INK.OCHRE, false, false);
  // head, nemes headdress with gold stripes and a turquoise beard
  z.box(x, 3.55, zz + 1.5, 2.5, 2.5, 2.3, INK.OCHRE, false, false);
  z.box(x, 3.5, zz + 2.5, 1.9, 2.3, 0.5, INK.SAND, false, false);
  z.box(x - 1.45, 3.5, zz + 1.4, 0.65, 2.7, 2.5, INK.SAND, false, false);
  z.box(x + 1.45, 3.5, zz + 1.4, 0.65, 2.7, 2.5, INK.SAND, false, false);
  for (let i = 0; i < 4; i++) {
    z.box(x - 1.45, 3.8 + i * 0.62, zz + 2.62, 0.66, 0.16, 0.1, INK.GOLD, true, false);
    z.box(x + 1.45, 3.8 + i * 0.62, zz + 2.62, 0.66, 0.16, 0.1, INK.GOLD, true, false);
  }
  z.box(x, 4.0, zz + 2.78, 1.6, 0.32, 0.18, INK.TURQ, true, false);
  z.box(x - 0.48, 4.55, zz + 2.8, 0.3, 0.11, 0.05, INK.GOLD, true, false);
  z.box(x + 0.48, 4.55, zz + 2.8, 0.3, 0.11, 0.05, INK.GOLD, true, false);
  z.box(x, 3.7, zz + 2.9, 0.3, 0.28, 0.1, INK.STONE, false, false);
  z.box(x, 3.15, zz + 2.9, 0.4, 0.35, 0.08, INK.STONE, false, false);
  z.box(x, 3.0, zz + 2.86, 0.3, 0.75, 0.15, INK.TURQ, true, false);
  z.collide(x, 0, zz, 13, 5.4, 8);
}

function obelisk(z: Zone, x: number, zz: number) {
  z.box(x, 0, zz, 2.2, 0.6, 2.2, INK.STONE);
  z.taper(x, 0.6, zz, 0.9, 0.5, 10.4, INK.SAND, 4, false, true);
  z.taper(x, 11.0, zz, 0.5, 0.06, 1.2, INK.GOLD, 4, true, false);
  for (let i = 0; i < 6; i++) z.box(x, 1.4 + i * 1.4, zz + 0.47, 0.5, 0.7, 0.05, INK.STONE, false, false);
}

function palm(z: Zone, x: number, zz: number, h = 5.4) {
  z.taper(x, 0, zz, 0.3, 0.18, h, INK.OCHRE, 6, false, true);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + x * 0.13;
    const len = 2.6 + (i % 3) * 0.35;
    const g = new THREE.BoxGeometry(len, 0.09, 0.5);
    g.rotateZ(-0.55);
    g.rotateY(a);
    g.translate(x + Math.cos(a) * len * 0.42, z.baseY + h + 0.15 - (i % 2) * 0.1, zz + Math.sin(a) * len * 0.42);
    z.addGeo(g, i % 2 ? INK.GREEN : INK.OCHRE);
  }
  z.sphere(x, h + 0.05, zz, 0.3, INK.OCHRE, false, 0.7, 6);
}

function cactus(z: Zone, x: number, zz: number) {
  z.cyl(x, 0, zz, 0.26, 1.9, INK.GREEN, true, true, 7);
  z.cyl(x - 0.42, 0.7, zz, 0.16, 0.8, INK.GREEN, true, false, 6);
  z.cyl(x + 0.38, 1.0, zz, 0.15, 0.7, INK.GREEN, true, false, 6);
  z.sphere(x, 1.95, zz, 0.28, INK.GREEN, true, 0.6, 6);
}

function crate(z: Zone, x: number, zz: number, s = 1) {
  z.box(x, 0, zz, 1.2 * s, 1.05 * s, 1.2 * s, INK.OCHRE);
  for (const [y, w] of [[0.08, 1.32], [0.52, 1.27], [0.96, 1.24]] as const) {
    z.box(x, y * s, zz, w * s, 0.11 * s, w * s, INK.STONE, false, false);
  }
  z.box(x, 1.05 * s, zz, 0.16 * s, 0.06 * s, 1.26 * s, INK.SAND, false, false);
}

function tent(z: Zone, x: number, zz: number, ink: InkId) {
  for (const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) {
    z.box(x + dx, 0, zz + dz, 0.12, 2.5, 0.12, INK.OCHRE, false, true);
  }
  z.taper(x, 2.4, zz, 2.5, 0.06, 1.5, ink, 4, false, false);
  z.box(x, 1.4, zz, 3.8, 0.12, 3.8, ink, true, false);
  z.box(x + 0.6, 0, zz + 0.3, 1.2, 0.9, 1.0, INK.OCHRE);
  z.box(x - 0.4, 0, zz + 1.1, 1.0, 1.0, 0.9, INK.SAND);
}

function chestBase(z: Zone, x: number, zz: number, big = false) {
  const s = big ? 1.35 : 1;
  z.box(x, 0, zz, 1.5 * s, 0.7 * s, 0.95 * s, INK.OCHRE);
  z.box(x, 0.7 * s, zz, 1.56 * s, 0.12 * s, 1.0 * s, INK.GOLD, true, false);
  z.box(x, 0.12 * s, zz + 0.49 * s, 0.55 * s, 0.42 * s, 0.05 * s, INK.GOLD, true, false);
  return s;
}

function sarcophagus(z: Zone, x: number, zz: number, big = false): THREE.Group {
  const s = big ? 1.3 : 1;
  z.box(x, 0, zz, 1.15 * s, 0.34 * s, 2.8 * s, INK.STONE);
  z.box(x, 0.34 * s, zz, 0.96 * s, 0.62 * s, 2.55 * s, INK.OCHRE);
  for (let i = 0; i < 4; i++) {
    z.box(x - 0.5 * s, 0.4 * s, zz - 1.0 * s + i * 0.6 * s, 0.04 * s, 0.5 * s, 0.24 * s, INK.GOLD, true, false);
    z.box(x + 0.5 * s, 0.4 * s, zz - 1.0 * s + i * 0.6 * s, 0.04 * s, 0.5 * s, 0.24 * s, INK.GOLD, true, false);
  }
  // the lid is its own group so it can slide open; the death mask rides on it
  const lid = new THREE.Group();
  lid.position.set(x, z.baseY + 0.96 * s + 0.12 * s, zz);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1.1 * s, 0.24 * s, 2.9 * s), makeInkMaterial(INK.SAND));
  lid.add(slab);
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.62 * s, 0.3 * s, 0.66 * s), makeInkMaterial(INK.GOLD, true));
  face.position.set(0, 0.2 * s, 0.92 * s);
  lid.add(face);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.16 * s, 0.16 * s, 1.1 * s), makeInkMaterial(INK.TURQ, true));
  stripe.position.set(0, 0.04 * s, 0.95 * s);
  lid.add(stripe);
  z.group.add(lid);
  z.collide(x, 0, zz, 1.3 * s, 1.2 * s, 3.0 * s);
  return lid;
}

function treasurePile(z: Zone, x: number, zz: number, n = 5) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.35 + (i % 3) * 0.22;
    z.sphere(x + Math.cos(a) * r, 0.12, zz + Math.sin(a) * r, 0.22 + (i % 2) * 0.1, i % 3 === 0 ? INK.TURQ : INK.GOLD, true, 0.55, 6);
  }
  z.sphere(x, 0.16, zz, 0.42, INK.GOLD, true, 0.4, 7);
}

/** a stepped pyramid whose walls are rings, so the middle stays hollow */
function pyramid(
  z: Zone,
  cx: number,
  cz: number,
  baseHalf: number,
  tiers: number,
  tierH: number,
  thick: number,
  doorWidth: number,
  doorH: number,
): { door: THREE.Mesh; doorCol: Collider; doorZ: number } {
  const topHalf = thick;
  const step = (baseHalf - topHalf) / Math.max(1, tiers - 1);
  let door: THREE.Mesh | null = null;
  let doorCol: Collider | null = null;
  let doorZ = 0;
  for (let i = 0; i < tiers; i++) {
    const half = baseHalf - i * step;
    const y = i * tierH;
    const zS = cz + half - thick / 2;
    const zN = cz - half + thick / 2;
    const xE = cx + half - thick / 2;
    const xW = cx - half + thick / 2;
    if (i === 0 && doorWidth > 0) {
      // south face split around the entrance, with a lintel over the gap
      const side = (half * 2 - doorWidth) / 2;
      z.box(cx - half + side / 2, y, zS, side, tierH, thick, INK.SAND);
      z.box(cx + half - side / 2, y, zS, side, tierH, thick, INK.SAND);
      if (doorH < tierH) z.box(cx, y + doorH, zS, doorWidth, tierH - doorH, thick, INK.SAND);
    } else {
      z.box(cx, y, zS, half * 2, tierH, thick, INK.SAND);
    }
    z.box(cx, y, zN, half * 2, tierH, thick, INK.SAND);
    z.box(xE, y, cz, thick, tierH, half * 2, INK.SAND);
    z.box(xW, y, cz, thick, tierH, half * 2, INK.SAND);
    z.box(cx, y, zS + thick / 2 - 0.01, half * 2, 0.07, 0.03, INK.OCHRE, false, false);
  }
  const capHalf = Math.max(thick, topHalf);
  z.box(cx, tiers * tierH, cz, capHalf * 2, 0.7, capHalf * 2, INK.GOLD);
  if (doorWidth > 0) {
    doorZ = cz + baseHalf - thick / 2;
    door = z.mesh(doorWidth, doorH, thick * 0.82, INK.STONE, cx, 0, doorZ);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.07, 14), makeInkMaterial(INK.GOLD, true));
    disc.rotation.x = Math.PI / 2;
    disc.position.set(0, 0, thick * 0.45);
    door.add(disc);
    doorCol = {
      minX: cx - doorWidth / 2,
      maxX: cx + doorWidth / 2,
      minY: z.baseY,
      maxY: z.baseY + doorH,
      minZ: doorZ - thick * 0.41,
      maxZ: doorZ + thick * 0.41,
    };
    z.colliders.push(doorCol);
  }
  return { door: door as THREE.Mesh, doorCol: doorCol as Collider, doorZ };
}

/* ============================== the map ============================== */

export type EgyptMap = {
  zones: Record<ZoneId, EgyptZone>;
  active: ZoneId;
  setZone: (id: ZoneId) => void;
  update: (t: number, dt: number, player: THREE.Vector3) => { tip?: string };
  nearest: (p: THREE.Vector3) => Prompt | null;
  activate: (id: string) => Outcome | null;
  hazard: (p: THREE.Vector3, now: number) => number;
  travelAt: (p: THREE.Vector3) => Outcome["travel"] | null;
  floorY: () => number;
};

export function buildEgypt(scene: THREE.Scene): EgyptMap {
  const zones: Record<ZoneId, EgyptZone> = {} as Record<ZoneId, EgyptZone>;
  const interactions: Interaction[] = [];
  const flames: Flames[] = [];
  const sliders: Slide[] = [];
  const hinges: { obj: THREE.Object3D; k: number; open: () => boolean }[] = [];
  const levers: { obj: THREE.Object3D; used: () => boolean }[] = [];
  const pits: { x: number; z: number; w: number; d: number; group: THREE.Group; baseY: number; phase: number; armed: () => boolean }[] = [];

  // state shared by geometry, interactions and the frame update
  let mainDoorOpen = false;
  let innerDoorOpen = false;
  let hatchOpen = false;
  let gateOpen = false;
  let plateTriggered = false;
  let secretOpen = false;
  let templeSecretOpen = false;
  let hurtUntil = 0;
  let lastPlateTip = -10;

  const add = (i: Interaction) => interactions.push(i);

  const addChest = (id: string, zone: Zone, x: number, zz: number, big: boolean, prompt: THREE.Vector3) => {
    const s = chestBase(zone, x, zz, big);
    let opened = false;
    const lid = new THREE.Group();
    lid.position.set(x, zone.baseY + 0.82 * s, zz - 0.42 * s);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.5 * s, 0.16 * s, 0.95 * s), makeInkMaterial(INK.GOLD, true));
    top.position.set(0, 0.06 * s, 0.42 * s);
    lid.add(top);
    zone.group.add(lid);
    hinges.push({ obj: lid, k: 0, open: () => opened });
    add({
      id,
      pos: prompt,
      radius: 3.0,
      label: () => (opened ? null : "OPEN TREASURE CHEST"),
      run: () => {
        if (opened) return null;
        opened = true;
        return {
          loot: big ? { health: 45, ammo: 40, grenades: 2, score: 350 } : { health: 22, ammo: 24, grenades: 1, score: 160 },
          sound: "chest",
          tip: big ? "gold, and something older" : "supplies",
        };
      },
    });
  };

  /**
   * A spike pit built from one merged mesh: every spike in the floor moves
   * together, so 40 cones cost one draw call instead of forty.
   */
  const spikePit = (zone: Zone, x: number, zz: number, w: number, d: number, phase: number, armed: () => boolean) => {
    zone.box(x, 0.01, zz, w, 0.03, d, INK.BLACK, false, false);
    zone.box(x, 0.02, zz, w + 0.4, 0.04, 0.14, INK.GOLD, false, false);
    zone.box(x, 0.02, zz, 0.14, 0.04, d + 0.4, INK.GOLD, false, false);
    const cone = new THREE.ConeGeometry(0.13, 0.85, 5);
    const geos: THREE.BufferGeometry[] = [];
    const n = Math.max(2, Math.floor(w / 0.65));
    const m = Math.max(2, Math.floor(d / 0.65));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < m; j++) {
        const sx = -w / 2 + 0.45 + (i * (w - 0.9)) / Math.max(1, n - 1);
        const sz = -d / 2 + 0.45 + (j * (d - 0.9)) / Math.max(1, m - 1);
        geos.push(cone.clone().translate(sx, 0, sz));
      }
    }
    cone.dispose();
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) return;
    const g = new THREE.Group();
    const spikes = new THREE.Mesh(merged, makeInkMaterial(INK.BONE));
    spikes.frustumCulled = false;
    g.add(spikes);
    g.position.set(x, zone.baseY - 0.9, zz);
    zone.group.add(g);
    pits.push({ x, z: zz, w, d, group: g, baseY: zone.baseY - 0.9, phase, armed });
  };

  const addSarc = (id: string, zone: Zone, x: number, zz: number, big: boolean, prompt: THREE.Vector3) => {
    const lid = sarcophagus(zone, x, zz, big);
    let opened = false;
    add({
      id,
      pos: prompt,
      radius: 3.2,
      label: () => (opened ? null : "OPEN THE SARCOPHAGUS"),
      run: () => {
        if (opened) return null;
        opened = true;
        sliders.push({ obj: lid, base: lid.position.clone(), dir: new THREE.Vector3(1, 0, 0), dist: 2.9 * (big ? 1.3 : 1), open: () => opened, colliderLive: false, k: 0 });
        return {
          awaken: [new THREE.Vector3(x, zone.baseY + 0.2, zz)],
          tip: "<b>THE LID SLIDES</b> · something is getting up",
          sound: "mummy",
          loot: big ? { health: 45, ammo: 40, grenades: 2, score: 500 } : undefined,
        };
      },
    });
  };

  /* ------------------------------------------------------------------ *
   * SURFACE — The Pharaoh's Valley
   * ------------------------------------------------------------------ */
  const S = new Zone(0);
  zones.surface = {
    id: "surface",
    title: "THE PHARAOH'S VALLEY",
    sub: "open desert · three pyramids · temple · sphinx",
    group: S.group,
    colliders: S.colliders,
    bounds: { minX: -59, maxX: 59, minZ: -59, maxZ: 59 },
    floorY: 0,
    spawnPoints: S.spawns,
    start: new THREE.Vector3(0, 0.2, 44),
    startYaw: 0,
    mood: { paper: [0.95, 0.89, 0.74], chalk: 0.06, lines: 0, background: 0xe6c987 },
    dormant: [],
  };

  // --- desert floor, split around the dry canyon on the west edge ---
  S.box(7, -1, 0, 106, 1, 120, INK.SAND);
  // the western shelf is split around the stair cut, so the ramp is a hole in
  // the ground rather than a staircase buried inside a solid slab
  S.box(-58, -1, 42, 4, 1, 36, INK.SAND);
  S.box(-49, -1, 42, 6, 1, 36, INK.SAND);
  S.box(-54, -1, 44.75, 4, 1, 30.5, INK.SAND);
  S.box(-53, -1, -43, 14, 1, 34, INK.SAND);
  S.box(-53, -3.5, -1, 14, 1, 50, INK.OCHRE); // canyon bed
  S.box(-46, -2.5, -1, 1.2, 2.5, 50, INK.STONE); // canyon east wall
  S.wallX(-60, -56, 24, -2.5, 2.5, 1.2, [], INK.STONE);
  S.wallX(-52, -46, 24, -2.5, 2.5, 1.2, [], INK.STONE);
  S.wallX(-60, -46, -26, -2.5, 2.5, 1.2, [], INK.STONE);
  S.stairs(-54, -2.5, 24, "+z", 10, 3.6, 0.25, 0.52, INK.OCHRE);
  for (let i = 0; i < 14; i++) {
    const a = i * 2.399;
    S.box(-53 + Math.cos(a) * 5, -2.47, -1 + Math.sin(a) * 20, 1.6 + (i % 3), 0.04, 0.14 + (i % 2) * 0.1, INK.STONE, false, false);
  }
  S.box(-57, -2.5, -8, 3, 1.2, 3, INK.STONE);
  S.box(-57, -1.3, -8, 1.4, 1.5, 1.4, INK.GOLD);
  addChest("chest-rim", S, -50, 30, true, new THREE.Vector3(-50, 1.4, 30));

  // --- boundary cliffs: chunky, irregular and impassable ---
  for (let i = 0; i < 9; i++) {
    const t = -58 + i * 14.5;
    S.box(-60.5, 0, t, 5 + (i % 3) * 2, 9 + (i % 4) * 2.2, 15, INK.OCHRE);
    S.box(60.5, 0, t, 5 + ((i + 1) % 3) * 2, 8 + ((i + 2) % 4) * 2.4, 15, INK.SAND);
    S.box(t, 0, -60.5, 15, 8.5 + (i % 3) * 2.6, 5, INK.SAND);
    S.box(t, 0, 60.5, 15, 10 + ((i + 2) % 3) * 2.1, 5, INK.OCHRE);
  }
  for (const [x, zz, r, h] of [[-48, 52, 3.2, 5], [48, 50, 4, 6.5], [52, -48, 3.6, 5.5], [-48, -50, 4.5, 7], [14, 52, 2.6, 3.6]] as const) {
    S.taper(x, 0, zz, r, r * 0.55, h, INK.OCHRE, 6, false, true);
  }

  // --- dunes, rocks, cracked ground ---
  // Drifts pile up against the southern cliffs, clear of the temple: a mound
  // swelling over the colonnade would read as a modelling slip, not weather.
  S.dune(-48, -52, 9, 2.6);
  S.dune(-24, -53, 8, 2.2);
  S.dune(46, 20, 12, 3.2);
  S.dune(38, -44, 10, 2.6);
  S.dune(-12, -50, 8, 1.8);
  S.dune(20, 48, 9, 2.4);
  for (let i = 0; i < 16; i++) {
    const a = i * 2.399 + 0.6;
    const r = 8 + (i % 5) * 6;
    const rad = 0.5 + (i % 3) * 0.35;
    const sx = Math.cos(a) * r;
    const sz = Math.sin(a) * r;
    S.sphere(sx, 0, sz, rad, i % 2 ? INK.STONE : INK.OCHRE, false, 0.7, 6);
    // a low block tucked inside the stone's silhouette: you clamber over a
    // boulder instead of walking through it
    S.collide(sx, 0, sz, rad * 1.5, Math.min(0.5, rad * 0.5), rad * 1.5);
  }
  for (let i = 0; i < 12; i++) {
    const a = i * 1.7;
    S.box(Math.cos(a) * 24, 0.01, 28 + Math.sin(a) * 6, 1.2 + (i % 3), 0.03, 0.16, INK.OCHRE, false, false);
  }

  // --- the great pyramid, hollow and enterable ---
  const main = pyramid(S, 0, 0, 18, 9, 3, 2.6, 3.4, 2.9);
  S.slab(-15.4, -15.4, 15.4, 15.4, 0.04, 0.1, INK.OCHRE, false);
  for (const [x, zz] of [[-6.4, -6.4], [6.4, -6.4], [-6.4, 6.4], [6.4, 6.4], [-9.4, 0], [9.4, 0], [0, -9.4], [0, 9.4]] as const) {
    S.cyl(x, 0, zz, 0.85, 7.4, INK.SAND, false, true, 10);
    S.ring(x, 5.4, zz, 0.9, 0.13, INK.GOLD);
    S.box(x, 7.2, zz, 2.3, 0.4, 2.3, INK.OCHRE);
  }
  // banded either side of the doorway: a glyph strip across the opening would
  // hang in the doorway once the stone door lifts
  S.glyphs(-6.5, 1.0, 15.36, "x", 8, 2.2, 2);
  S.glyphs(6.5, 1.0, 15.36, "x", 8, 2.2, 2);
  S.glyphs(-15.35, 1.0, 0, "z", 10, 2.2, 2);
  S.glyphs(15.35, 1.0, 0, "z", 10, 2.2, 2);
  S.glyphs(0, 1.0, -15.36, "x", 9, 2.2, 2);
  for (const [x, zz] of [[-3.4, 12.6], [3.4, 12.6], [-9.4, -2.6], [9.4, 2.6]] as const) torch(S, x, 1.3, zz, flames);
  anubis(S, -3.6, 13.2, 0.72);
  anubis(S, 3.6, 13.2, 0.72);
  // This hollow is the entrance vestibule only; the sanctuary proper (with the
  // concealed stair) is its own area, a few steps through the doorway. No wave
  // pads are put behind the great door: a spawn the player cannot reach would
  // only be rescued by the path-fail valve, which reads as an enemy popping in.


  // --- two smaller pyramids, each with a real chamber you can walk into ---
  const small = (cx: number, cz: number, idp: string) => {
    const p = pyramid(S, cx, cz, 9, 5, 2.2, 1.8, 2.4, 2.1);
    S.slab(cx - 7.2, cz - 7.2, cx + 7.2, cz + 7.2, 0.06, 0.1, INK.OCHRE, false);
    S.glyphs(cx - 4, 0.5, cz + 7.2, "x", 3.6, 1.1, 2);
    S.glyphs(cx + 4, 0.5, cz + 7.2, "x", 3.6, 1.1, 2);
    S.glyphs(cx, 0.5, cz - 7.2, "x", 5, 1.1, 2);
    torch(S, cx - 3, 0.8, cz - 3, flames);
    torch(S, cx + 3, 0.8, cz - 3, flames);
    addSarc(`${idp}-sarc`, S, cx - 1.8, cz - 2, false, new THREE.Vector3(cx - 1.8, 1.2, cz - 2));
    addChest(`${idp}-chest`, S, cx + 3.2, cz + 2.4, false, new THREE.Vector3(cx + 3.2, 1.2, cz + 2.4));
    let open = false;
    // The stepped face has no masonry above the doorway for a slab to vanish
    // into, so a small tomb's door sinks into the sand instead of hanging in
    // the air over the entrance.
    sliders.push({ obj: p.door, base: p.door.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 2.1, open: () => open, collider: p.doorCol, owner: S.colliders, colliderLive: true, k: 0 });
    add({
      id: `${idp}-door`,
      pos: new THREE.Vector3(cx, 1.2, p.doorZ + 2.2),
      radius: 3.8,
      label: () => (open ? null : "OPEN THE TOMB DOOR"),
      run: () => {
        open = true;
        return { tip: "the smaller tomb opens", sound: "stone" };
      },
    });
  };
  small(-36, 26, "west-pyramid");
  small(36, -24, "east-pyramid");

  // --- temple: pylon gates, colonnade, sanctum, secret alcove ---
  const TX = -34;
  const TZ = -34;
  S.slab(TX - 12, TZ - 9, TX + 12, TZ + 9, 0.9, 0.9, INK.OCHRE);
  S.stairs(TX, 0, TZ + 10.4, "-z", 3, 8, 0.3, 0.55, INK.SAND);
  for (const x of [TX - 10, TX + 10]) {
    S.box(x, 0.9, TZ + 7.8, 5.2, 9.4, 5.2, INK.SAND);
    S.box(x, 10.3, TZ + 7.8, 5.7, 0.7, 5.7, INK.OCHRE);
    S.glyphs(x, 3.2, TZ + 10.42, "x", 3.6, 4.4, 3);
  }
  S.box(TX, 10.3, TZ + 7.8, 15, 1.1, 4.2, INK.OCHRE);
  for (const x of [TX - 7, TX - 3.5, TX, TX + 3.5, TX + 7]) {
    S.cyl(x, 0.9, TZ + 5, 0.82, 8.2, INK.SAND, false, true, 10);
    S.ring(x, 7.4, TZ + 5, 0.86, 0.13, INK.TURQ);
    S.box(x, 8.4, TZ + 5, 2.1, 0.5, 2.1, INK.OCHRE);
  }
  S.box(TX, 8.9, TZ + 5, 16, 0.6, 2.6, INK.OCHRE);
  // facade, side walls, back wall and the sanctum partition
  S.wallX(TX - 11.5, TX + 11.5, TZ + 8, 0.9, 8.4, 1, [[TX - 4, TX + 4, 0, 6.4]], INK.SAND);
  S.wallZ(TZ - 8.5, TZ + 8, TX - 11.5, 0.9, 8.4, 1, [], INK.SAND);
  S.wallZ(TZ - 8.5, TZ + 8, TX + 11.5, 0.9, 8.4, 1, [[TZ - 7, TZ - 4, 0, 5.6]], INK.SAND);
  S.wallX(TX - 11.5, TX + 11.5, TZ - 8.5, 0.9, 8.4, 1, [], INK.SAND);
  S.wallX(TX - 11.5, TX + 11.5, TZ - 2, 0.9, 8.4, 0.9, [[TX - 1.7, TX + 1.7, 0, 4.6]], INK.OCHRE);
  S.glyphs(TX - 7.4, 2.2, TZ + 7.45, "x", 6, 3.4, 3);
  S.glyphs(TX + 7.4, 2.2, TZ + 7.45, "x", 6, 3.4, 3);
  S.glyphs(TX - 11.02, 2.2, TZ + 2, "z", 12, 3.4, 3);
  S.glyphs(TX + 11.02, 2.2, TZ + 2, "z", 12, 3.4, 3);
  // pharaoh in the sanctum
  S.box(TX, 0.9, TZ - 5, 2.6, 0.8, 2.6, INK.STONE);
  S.box(TX, 1.7, TZ - 5, 1.5, 3.2, 1.2, INK.GOLD);
  S.box(TX, 3.0, TZ - 5, 1.8, 0.6, 1.4, INK.TURQ, true, false);
  S.box(TX, 4.9, TZ - 5, 1.1, 1.2, 1.1, INK.GOLD);
  S.box(TX, 4.4, TZ - 5, 1.7, 0.35, 1.7, INK.TURQ, true, false);
  S.box(TX, 5.6, TZ - 5, 0.3, 0.5, 0.9, INK.GOLD);
  addChest("chest-temple", S, TX + 8.4, TZ + 3, true, new THREE.Vector3(TX + 8.4, 1.4, TZ + 3));
  addChest("chest-temple-2", S, TX - 8.4, TZ + 3, false, new THREE.Vector3(TX - 8.4, 1.4, TZ + 3));
  // secret alcove through the east wall, opened by the lever inside the sanctum
  S.slab(TX + 11.5, TZ - 8, TX + 16, TZ - 3, 0.9, 0.4, INK.OCHRE);
  S.wallZ(TZ - 8.5, TZ - 3, TX + 16, 0.9, 6, 0.7, [], INK.STONE);
  S.wallX(TX + 11.5, TX + 16, TZ - 8, 0.9, 6, 0.7, [], INK.STONE);
  S.wallX(TX + 11.5, TX + 16, TZ - 3, 0.9, 6, 0.7, [], INK.STONE);
  S.box(TX + 11.5, 6.9, TZ - 5.5, 5.2, 0.4, 5.6, INK.STONE);
  const templeSecret = S.mesh(0.7, 6, 3.2, INK.STONE, TX + 11.5, 0.9, TZ - 5.5);
  const templeSecretCol: Collider = { minX: TX + 11.15, maxX: TX + 11.85, minY: 0.9, maxY: 6.9, minZ: TZ - 7.1, maxZ: TZ - 3.9 };
  S.colliders.push(templeSecretCol);
  sliders.push({ obj: templeSecret, base: templeSecret.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 6.2, open: () => templeSecretOpen, collider: templeSecretCol, owner: S.colliders, colliderLive: true, k: 0 });
  // tucked deep enough that the vault's own wall denies the prompt: standing in
  // the sanctum must not advertise a chest behind a hidden door
  addChest("chest-temple-secret", S, TX + 14.5, TZ - 5.5, true, new THREE.Vector3(TX + 14.5, 1.4, TZ - 5.5));
  treasurePile(S, TX + 13.4, TZ - 4.4);
  const templeLever = S.mesh(0.2, 1.4, 0.2, INK.GOLD, TX + 9.4, 1.1, TZ - 5.5);
  S.box(TX + 9.4, 1.0, TZ - 5.5, 0.7, 0.4, 0.9, INK.STONE, false, false);
  levers.push({ obj: templeLever, used: () => templeSecretOpen });
  add({
    id: "temple-lever",
    pos: new THREE.Vector3(TX + 9.4, 1.4, TZ - 5.5),
    radius: 3.2,
    label: () => (templeSecretOpen ? null : "PULL THE TEMPLE LEVER"),
    run: () => {
      if (templeSecretOpen) return null;
      templeSecretOpen = true;
      return { tip: "a hidden wall sinks into the sand", sound: "stone" };
    },
  });
  S.spawns.push(new THREE.Vector3(TX, 0.2, TZ + 16), new THREE.Vector3(TX - 8, 0.2, TZ + 13), new THREE.Vector3(TX + 8, 0.2, TZ + 13));

  // --- sphinx, obelisks, ruins, market, camp, oasis ---
  sphinx(S, 34, 36);
  obelisk(S, -10, 28);
  obelisk(S, 20, -34);
  obelisk(S, TX + 15, TZ + 13);
  ruin(S, 20, 12);
  ruin(S, -24, -10);
  ruin(S, 12, -38);
  ruin(S, -10, -30);
  makeMarket(S, 12, 34);
  makeMarket(S, 24, 22);
  makeCamp(S, -18, 42);
  S.disc(-28, 0.03, 46, 4.6, INK.TURQ, false, 22);
  S.ring(-28, 0.06, 46, 4.6, 0.32, INK.SAND, false);
  for (const [x, zz] of [[-33.5, 43], [-28, 50.5], [-22.5, 43.5], [-32, 50], [-24, 51]] as const) palm(S, x, zz, 4.6 + (x % 3) * 0.3);
  cactus(S, 44, 8);
  cactus(S, 48, 30);
  cactus(S, -44, -8);
  for (const [x, zz] of [[-6, 36], [18, 6], [-20, 16], [8, -30], [40, -6]] as const) palm(S, x, zz, 5 - (x % 2) * 0.4);
  for (const [x, zz] of [[10, 40], [-12, 20], [24, 0], [-6, -20], [30, 10], [-30, 6], [6, 24], [-38, -18]] as const) {
    S.spawns.push(new THREE.Vector3(x, 0.2, zz));
  }

  // great pyramid entrance: open the door, then walk through it
  sliders.push({ obj: main.door, base: main.door.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 3.0, open: () => mainDoorOpen, collider: main.doorCol, owner: S.colliders, colliderLive: true, k: 0 });
  add({
    id: "main-door",
    pos: new THREE.Vector3(0, 1.2, 20.4),
    radius: 4.4,
    label: () => (mainDoorOpen ? null : "OPEN THE GREAT STONE DOOR"),
    run: () => {
      mainDoorOpen = true;
      return { tip: "the stone grinds down into the sand · enter the sanctuary", sound: "stone" };
    },
  });
  S.flush();

  /* ------------------------------------------------------------------ *
   * INTERIOR — The Forgotten Sanctuary
   * ------------------------------------------------------------------ */
  const F = new Zone(-140);
  zones.interior = {
    id: "interior",
    title: "THE FORGOTTEN SANCTUARY",
    sub: "processional corridor · carved chamber · hidden stair",
    group: F.group,
    colliders: F.colliders,
    bounds: { minX: -17, maxX: 17, minZ: -17, maxZ: 17 },
    floorY: -140,
    spawnPoints: F.spawns,
    start: new THREE.Vector3(0, -139.8, 13),
    startYaw: 0,
    mood: { paper: [0.78, 0.65, 0.47], chalk: 0.3, lines: 0, background: 0x8a6b46 },
    dormant: [{ pos: new THREE.Vector3(12, -139.8, -4), yaw: Math.PI }],
  };

  F.slab(-16, -16, 16, 16, 0.02, 0.2, INK.OCHRE, false);
  F.box(0, -0.4, 0, 32, 0.4, 32, INK.STONE);
  F.wallX(-16, 16, 16, 0, 9, 1, [[-1.8, 1.8, 0, 3.3]], INK.STONE);
  F.wallX(-16, 16, -16, 0, 9, 1, [], INK.STONE);
  F.wallZ(-16, 16, -16, 0, 9, 1, [], INK.STONE);
  F.wallZ(-16, 16, 16, 0, 9, 1, [], INK.STONE);
  // one closed slab roof: a carved chamber needs a ceiling that does not leak
  // the desert sky through its seams when the player looks up
  F.slab(-16, -16, 16, 16, 9.8, 0.8, INK.STONE, false);
  // A low processional corridor from the outer door to the chamber. Zone B is
  // meant to feel like the inside of a pyramid — a squeeze before the hall — not
  // one open room with a door on it. It also gives the doorway a shadowed
  // approach instead of showing the whole sanctuary at once.
  F.wallZ(5.5, 16, -2.7, 0, 7, 0.8, [], INK.STONE);
  F.wallZ(5.5, 16, 2.7, 0, 7, 0.8, [], INK.STONE);
  F.slab(-3.1, 5.5, 3.1, 16, 7.4, 0.5, INK.STONE, false);
  F.glyphs(-2.28, 1.0, 10.5, "z", 6, 2.2, 2);
  F.glyphs(2.28, 1.0, 10.5, "z", 6, 2.2, 2);
  torch(F, -2.15, 1.7, 6.5, flames);
  torch(F, 2.15, 1.7, 14.4, flames);
  F.glyphs(-9.5, 1.0, 15.45, "x", 12, 2.6, 3);
  F.glyphs(9.5, 1.0, 15.45, "x", 12, 2.6, 3);
  F.glyphs(0, 3.7, 15.45, "x", 4, 1.2, 1);
  F.glyphs(0, 1.0, -15.45, "x", 8, 2.6, 3);
  F.glyphs(-15.45, 1.0, 0, "z", 9, 2.6, 3);
  F.glyphs(15.45, 1.0, 0, "z", 9, 2.6, 3);
  for (const [x, zz] of [[-8.4, -8.4], [8.4, -8.4], [-8.4, 8.4], [8.4, 8.4], [-11, 0], [11, 0]] as const) {
    F.cyl(x, 0, zz, 0.9, 8.8, INK.SAND, false, true, 10);
    F.ring(x, 6.6, zz, 0.95, 0.14, INK.GOLD);
    F.box(x, 8.8, zz, 2.4, 0.5, 2.4, INK.OCHRE);
    torch(F, x, 2.0, zz + (zz < 0 ? 1.05 : -1.05), flames);
  }
  // The concealed stair: a low stone dais with a hatch in the top. Under the
  // hatch is a black opening with the edges of the top steps showing, so when
  // the slab slides aside it reads as a way down rather than a bare disc.
  F.cyl(0, 0, 0, 3.4, 0.5, INK.STONE, false, true, 10);
  F.ring(0, 0.52, 0, 2.5, 0.14, INK.GOLD);
  F.box(0, 0.5, 0, 3.0, 0.05, 3.0, INK.BLACK, false, false);
  for (let i = 0; i < 4; i++) {
    // a stair edge catching the torchlight, narrowing as it descends
    F.box(0, 0.55, 1.15 - i * 0.24, 2.5 - i * 0.5, 0.006, 0.1, INK.STONE, false, false);
    F.box(0, 0.55, 1.25 - i * 0.24, 2.4 - i * 0.5, 0.005, 0.06, INK.OCHRE, false, false);
  }
  const innerHatch = F.mesh(2.8, 0.16, 2.8, INK.SAND, 0, 0.56, 0);
  // side chapel
  F.wallZ(-8, 8, 8, 0, 7, 0.6, [[-1.2, 1.2, 0, 4]], INK.OCHRE);
  F.wallX(8, 16, 8, 0, 7, 0.6, [], INK.OCHRE);
  F.wallX(8, 16, -8, 0, 7, 0.6, [], INK.OCHRE);
  F.glyphs(8.35, 1.0, 4.6, "z", 4, 2.2, 2);
  addChest("chest-interior", F, 12.6, 4.6, true, new THREE.Vector3(12.6, -139.4, 4.6));
  treasurePile(F, 12.4, 0.4);
  addSarc("sarc-interior", F, 13.2, -5.6, false, new THREE.Vector3(13.2, -139.4, -5.6));
  // one of the sanctuary's original floor traps, still armed: the west aisle is
  // safe to walk, but cutting the corner costs health
  spikePit(F, -12.4, 3.2, 3.2, 3.2, 0.7, () => true);
  torch(F, 9, 1.8, -6.7, flames);
  // pharaoh niche at the north wall
  F.box(0, 0, -14.2, 3.4, 0.9, 2.0, INK.STONE);
  F.box(0, 0.9, -14.2, 1.7, 3.6, 1.2, INK.GOLD);
  F.box(0, 2.4, -14.2, 2.1, 0.6, 1.5, INK.TURQ, true, false);
  F.box(0, 4.5, -14.2, 1.2, 1.3, 1.2, INK.GOLD);
  F.box(0, 5.8, -14.2, 0.35, 0.5, 0.9, INK.GOLD);
  F.box(0, 4.0, -14.2, 1.9, 0.35, 1.6, INK.TURQ, true, false);
  anubis(F, -3.6, -13.6, 0.8);
  anubis(F, 3.6, -13.6, 0.8);
  torch(F, -6.2, 1.4, -14.0, flames);
  torch(F, 6.2, 1.4, -14.0, flames);
  F.spawns.push(new THREE.Vector3(0, -139.8, 8), new THREE.Vector3(11, -139.8, 6), new THREE.Vector3(-11, -139.8, 6), new THREE.Vector3(0, -139.8, -6));
  const innerDoor = F.mesh(3.4, 3.3, 0.9, INK.STONE, 0, 0, 15.6);
  const innerDoorCol: Collider = { minX: -1.7, maxX: 1.7, minY: -140, maxY: -136.7, minZ: 15.15, maxZ: 16.05 };
  F.colliders.push(innerDoorCol);
  sliders.push({ obj: innerDoor, base: innerDoor.position.clone(), dir: new THREE.Vector3(0, 1, 0), dist: 3.5, open: () => innerDoorOpen, collider: innerDoorCol, owner: F.colliders, colliderLive: true, k: 0 });
  // The hatch is wider than the dais is free on either side, so it sinks into
  // the stone rather than sliding out over the floor.
  sliders.push({ obj: innerHatch, base: innerHatch.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 0.75, open: () => hatchOpen, colliderLive: false, k: 0 });
  add({
    id: "inner-exit",
    pos: new THREE.Vector3(0, -138.8, 14.2),
    radius: 3.8,
    label: () => (innerDoorOpen ? "STEP OUTSIDE" : "OPEN THE SANCTUARY DOOR"),
    run: () => {
      if (!innerDoorOpen) {
        innerDoorOpen = true;
        return { tip: "outside, the valley glares", sound: "stone" };
      }
      return { travel: { zone: "surface", x: 0, y: 0.2, z: 22, yaw: Math.PI } };
    },
  });
  add({
    id: "hatch",
    pos: new THREE.Vector3(0, -139.2, 0),
    radius: 3.9,
    label: () => (hatchOpen ? "DESCEND INTO THE CURSED TOMB" : "OPEN THE HIDDEN STAIRCASE"),
    run: () => {
      if (!hatchOpen) {
        hatchOpen = true;
        return { tip: "<b>THE FLOOR GRINDS ASIDE</b> · a stair descends into the dark", sound: "stone" };
      }
      return { travel: { zone: "tomb", x: 0, y: -299.8, z: 34, yaw: 0 } };
    },
  });
  F.flush();

  /* ------------------------------------------------------------------ *
   * TOMB — The Cursed Tomb
   * ------------------------------------------------------------------ */
  const T = new Zone(-300);
  zones.tomb = {
    id: "tomb",
    title: "THE CURSED TOMB",
    sub: "burial halls · sealed doors · mummies",
    group: T.group,
    colliders: T.colliders,
    bounds: { minX: -49, maxX: 49, minZ: -59, maxZ: 45 },
    floorY: -300,
    spawnPoints: T.spawns,
    start: new THREE.Vector3(0, -299.8, 34),
    startYaw: 0,
    mood: { paper: [0.16, 0.13, 0.11], chalk: 0.92, lines: 2, background: 0x17120f },
    dormant: [
      { pos: new THREE.Vector3(0, -299.8, -6), yaw: 0 },
      { pos: new THREE.Vector3(-28, -299.8, 1), yaw: Math.PI / 2 },
      { pos: new THREE.Vector3(0, -299.8, -34), yaw: 0 },
      { pos: new THREE.Vector3(0, -299.8, -52), yaw: 0 },
    ],
  };

  T.slab(-48, -58, 48, 44, 0.02, 0.3, INK.STONE, false);
  T.box(0, -0.6, -7, 96, 0.6, 102, INK.STONE);
  T.wallX(-48, 48, 44, 0, 9, 2, [], INK.STONE);
  T.wallX(-48, 48, -58, 0, 9, 2, [], INK.STONE);
  T.wallZ(-58, 44, -48, 0, 9, 2, [], INK.STONE);
  T.wallZ(-58, 44, 48, 0, 9, 2, [], INK.STONE);
  // entry hall + return stair
  T.wallX(-48, 48, 30, 0, 9, 1.2, [[-2.4, 2.4, 0, 5.0]], INK.STONE);
  T.stairs(0, 0, 37.5, "+z", 12, 3.6, 0.28, 0.5, INK.OCHRE);
  T.box(0, 3.4, 43.6, 5, 2.4, 1.2, INK.STONE);
  T.glyphs(-6.5, 1.4, 43.0, "x", 8, 3, 3);
  T.glyphs(6.5, 1.4, 43.0, "x", 8, 3, 3);
  torch(T, -6.8, 1.8, 41.6, flames);
  torch(T, 6.8, 1.8, 41.6, flames);
  T.spawns.push(new THREE.Vector3(0, -299.8, 34), new THREE.Vector3(-6, -299.8, 36), new THREE.Vector3(6, -299.8, 36));
  // corridor into the central hall
  T.wallZ(12, 30, -4, 0, 9, 1, [], INK.STONE);
  T.wallZ(12, 30, 4, 0, 9, 1, [], INK.STONE);
  T.box(-26, 0, 21.25, 44, 9, 17.5, INK.STONE);
  T.box(26, 0, 21.25, 44, 9, 17.5, INK.STONE);
  T.glyphs(-3.45, 1.4, 21, "z", 12, 2.8, 3);
  T.glyphs(3.45, 1.4, 21, "z", 12, 2.8, 3);
  for (const zz of [15, 21, 27]) {
    torch(T, -3.3, 1.7, zz, flames);
    torch(T, 3.3, 1.7, zz + 2, flames);
  }
  // central hall
  T.wallX(-14, 14, 12, 0, 9, 1, [[-4, 4, 0, 5.4]], INK.STONE);
  T.wallX(-14, 14, -10, 0, 9, 1, [[-2, 2, 0, 4.6]], INK.STONE);
  T.wallZ(-10, 12, -14, 0, 9, 1, [[-2.2, 2.2, 0, 4.4]], INK.STONE);
  T.wallZ(-10, 12, 14, 0, 9, 1, [[-2.2, 2.2, 0, 4.4]], INK.STONE);
  for (const [x, zz] of [[-7, -6], [7, -6], [-7, 0], [7, 0], [-7, 6], [7, 6]] as const) {
    T.cyl(x, 0, zz, 0.9, 8.6, INK.OCHRE, false, true, 10);
    T.ring(x, 5.6, zz, 0.95, 0.14, INK.GOLD);
    T.box(x, 8.6, zz, 2.4, 0.4, 2.4, INK.STONE, false, false);
  }
  T.glyphs(0, 1.2, 11.45, "x", 10, 3, 3);
  T.glyphs(0, 1.2, -9.45, "x", 8, 3, 3);
  T.glyphs(-13.45, 1.2, 1, "z", 9, 3, 3);
  T.glyphs(13.45, 1.2, 1, "z", 9, 3, 3);
  anubis(T, -10.6, -8.4, 1.05);
  anubis(T, 10.6, -8.4, 1.05);
  torch(T, -12.6, 1.6, 8.2, flames);
  torch(T, 12.6, 1.6, 8.2, flames);
  torch(T, -12.6, 1.6, -6.6, flames);
  torch(T, 12.6, 1.6, -6.6, flames);
  // pressure plate + the sealed gate it opens
  T.disc(0, 0.05, 2, 1.5, INK.TURQ, true, 18);
  T.ring(0, 0.07, 2, 1.5, 0.1, INK.GOLD);
  const plate = T.mesh(2.2, 0.12, 2.2, INK.TURQ, 0, 0.03, 2);
  const gate = T.mesh(4, 4.5, 1, INK.STONE, 0, 0, -10);
  const gateCol: Collider = { minX: -2, maxX: 2, minY: -300, maxY: -295.5, minZ: -10.5, maxZ: -9.5 };
  T.colliders.push(gateCol);
  sliders.push({ obj: gate, base: gate.position.clone(), dir: new THREE.Vector3(0, 1, 0), dist: 4.6, open: () => gateOpen, collider: gateCol, owner: T.colliders, colliderLive: true, k: 0 });
  sliders.push({ obj: plate, base: plate.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 0.09, open: () => plateTriggered, colliderLive: false, k: 0 });

  // west burial chamber
  T.wallX(-48, -14, 10, 0, 8, 1, [], INK.STONE);
  T.wallX(-48, -14, -8, 0, 8, 1, [], INK.STONE);
  T.glyphs(-47, 1.2, 1, "z", 14, 3, 3);
  T.glyphs(-31, 1.2, 9.45, "x", 12, 3, 3);
  T.glyphs(-31, 1.2, -7.45, "x", 12, 3, 3);
  addSarc("sarc-west-1", T, -42, 5.4, false, new THREE.Vector3(-42, -299.4, 5.4));
  addSarc("sarc-west-2", T, -42, -3.2, false, new THREE.Vector3(-42, -299.4, -3.2));
  addSarc("sarc-west-3", T, -21, -5, false, new THREE.Vector3(-21, -299.4, -5));
  addChest("chest-west-vault", T, -46, 8.4, false, new THREE.Vector3(-46, -299.4, 8.4));
  treasurePile(T, -45, 0);
  treasurePile(T, -33, 8.2);
  torch(T, -45, 1.6, 9.2, flames);
  torch(T, -45, 1.6, -7.2, flames);
  torch(T, -16, 1.6, 9.2, flames);
  T.spawns.push(new THREE.Vector3(-30, -299.8, 0), new THREE.Vector3(-44, -299.8, 1), new THREE.Vector3(-20, -299.8, 5));

  // east treasure vault
  T.wallX(14, 48, 10, 0, 8, 1, [], INK.STONE);
  T.wallX(14, 48, -8, 0, 8, 1, [], INK.STONE);
  T.glyphs(47, 1.2, 1, "z", 14, 3, 3);
  T.glyphs(31, 1.2, 9.45, "x", 12, 3, 3);
  T.glyphs(31, 1.2, -7.45, "x", 12, 3, 3);
  addSarc("sarc-vault", T, 24, 5, false, new THREE.Vector3(24, -299.4, 5));
  addChest("chest-vault", T, 32, -4.6, true, new THREE.Vector3(32, -299.4, -4.6));
  addChest("chest-vault-2", T, 42, 6.2, false, new THREE.Vector3(42, -299.4, 6.2));
  treasurePile(T, 32, 7.6);
  treasurePile(T, 43, -2);
  treasurePile(T, 28, 1.2);
  torch(T, 45, 1.6, 9.2, flames);
  torch(T, 45, 1.6, -7.2, flames);
  torch(T, 16, 1.6, 9.2, flames);
  T.spawns.push(new THREE.Vector3(30, -299.8, 0), new THREE.Vector3(44, -299.8, 2), new THREE.Vector3(20, -299.8, 4));
  // the lever that opens the pharaoh's secret wall
  const tombLever = T.mesh(0.22, 1.4, 0.22, INK.GOLD, 47.2, 1.1, 8.6);
  T.box(47, 1.0, 8.6, 0.7, 0.4, 1.0, INK.STONE, false, false);
  levers.push({ obj: tombLever, used: () => secretOpen });
  add({
    id: "tomb-lever",
    pos: new THREE.Vector3(46.4, -298.6, 8.6),
    radius: 3.4,
    label: () => (secretOpen ? null : "PULL THE ANCIENT LEVER"),
    run: () => {
      if (secretOpen) return null;
      secretOpen = true;
      return { tip: "<b>A MECHANISM CLICKS</b> · somewhere, a wall gives way", sound: "stone" };
    },
  });

  // north corridor + pharaoh room
  T.wallZ(-26, -10.5, -4, 0, 9, 1, [], INK.STONE);
  T.wallZ(-26, -10.5, 4, 0, 9, 1, [], INK.STONE);
  T.box(-26, 0, -18.25, 44, 9, 15.5, INK.STONE);
  T.box(26, 0, -18.25, 44, 9, 15.5, INK.STONE);
  T.glyphs(-3.45, 1.4, -18, "z", 12, 2.8, 3);
  T.glyphs(3.45, 1.4, -18, "z", 12, 2.8, 3);
  for (const zz of [-14, -21]) {
    torch(T, -3.3, 1.6, zz, flames);
    torch(T, 3.3, 1.6, zz, flames);
  }
  T.wallX(-16, 16, -26, 0, 9, 1, [[-2, 2, 0, 4.4]], INK.STONE);
  T.wallX(-16, 16, -46, 0, 9, 1, [[-1.8, 1.8, 0, 4.2]], INK.STONE);
  T.wallZ(-46, -26, -16, 0, 9, 1, [], INK.STONE);
  T.wallZ(-46, -26, 16, 0, 9, 1, [], INK.STONE);
  T.glyphs(-5.5, 1.2, -25.45, "x", 5, 3, 3);
  T.glyphs(5.5, 1.2, -25.45, "x", 5, 3, 3);
  T.glyphs(-15.45, 1.2, -36, "z", 12, 3, 3);
  T.glyphs(15.45, 1.2, -36, "z", 12, 3, 3);
  T.glyphs(-5, 1.2, -45.45, "x", 4.5, 3, 3);
  T.glyphs(5, 1.2, -45.45, "x", 4.5, 3, 3);
  for (const [x, zz] of [[-7, -42], [7, -42], [-7, -30], [7, -30]] as const) {
    T.cyl(x, 0, zz, 0.85, 8.6, INK.OCHRE, false, true, 10);
    T.ring(x, 5.6, zz, 0.9, 0.14, INK.GOLD);
    T.box(x, 8.6, zz, 2.3, 0.4, 2.3, INK.STONE, false, false);
  }
  anubis(T, -11.4, -28.4, 1.15);
  anubis(T, 11.4, -28.4, 1.15);
  addSarc("sarc-pharaoh", T, 0, -38, true, new THREE.Vector3(0, -298.6, -38));
  addChest("chest-pharaoh", T, 11.4, -43, true, new THREE.Vector3(11.4, -299.4, -43));
  treasurePile(T, -9, -42);
  treasurePile(T, 9, -34);
  torch(T, -14.6, 1.6, -44, flames);
  torch(T, 14.6, 1.6, -44, flames);
  torch(T, -14.6, 1.6, -28, flames);
  torch(T, 14.6, 1.6, -28, flames);
  T.spawns.push(new THREE.Vector3(0, -299.8, -32), new THREE.Vector3(-10, -299.8, -40), new THREE.Vector3(10, -299.8, -40));
  // the secret wall, slid away by the vault lever
  const secretWall = T.mesh(3.7, 4.3, 0.9, INK.STONE, 0, 0, -46);
  const secretWallCol: Collider = { minX: -1.85, maxX: 1.85, minY: -300, maxY: -295.7, minZ: -46.45, maxZ: -45.55 };
  T.colliders.push(secretWallCol);
  sliders.push({ obj: secretWall, base: secretWall.position.clone(), dir: new THREE.Vector3(0, -1, 0), dist: 4.4, open: () => secretOpen, collider: secretWallCol, owner: T.colliders, colliderLive: true, k: 0 });

  // secret vault
  T.wallZ(-58, -46, -10, 0, 8, 1, [], INK.STONE);
  T.wallZ(-58, -46, 10, 0, 8, 1, [], INK.STONE);
  T.glyphs(-9.45, 1.2, -52, "z", 10, 2.8, 3);
  T.glyphs(9.45, 1.2, -52, "z", 10, 2.8, 3);
  T.glyphs(0, 1.2, -57.45, "x", 8, 2.8, 3);
  addChest("chest-secret", T, 0, -54, true, new THREE.Vector3(0, -298.6, -54));
  // a turquoise scarab on a plinth: the one thing in the vault that still glows
  T.box(6, 0, -53.4, 1.3, 1.0, 1.3, INK.STONE);
  T.sphere(6, 1.3, -53.4, 0.3, INK.TURQ, true, 1, 8);
  T.ring(6, 1.32, -53.4, 0.46, 0.05, INK.GOLD, true);
  treasurePile(T, -5, -53);
  treasurePile(T, 5, -53);
  treasurePile(T, 0, -48);
  torch(T, -8, 1.6, -56, flames);
  torch(T, 8, 1.6, -56, flames);
  T.spawns.push(new THREE.Vector3(0, -299.8, -52), new THREE.Vector3(-5, -299.8, -47));

  // spike pits: the north corridor cycles from the start; the plate arms the rest
  spikePit(T, -22, 2, 5.4, 4.4, 1.1, () => plateTriggered);
  spikePit(T, 0, -18, 5, 4.6, 0.2, () => true);
  spikePit(T, -32, -1, 4.2, 4.2, 2.4, () => plateTriggered);
  add({
    id: "tomb-exit",
    pos: new THREE.Vector3(0, -298.4, 40.5),
    radius: 4.4,
    label: () => "CLIMB BACK TO THE SANCTUARY",
    run: () => ({ travel: { zone: "interior", x: 0, y: -139.8, z: 5, yaw: Math.PI } }),
  });

  // drifting dust — folded into one ink mesh, because the post pass reads the
  // scene buffer as shade/ink/normal *data*: a normal-coloured Points material
  // would be decoded as an ink id and paint bright blotches through the tomb.
  const dustGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 90; i++) {
    const g = new THREE.BoxGeometry(0.055, 0.055, 0.055);
    g.translate(Math.sin(i * 7.13) * 40, T.baseY + 0.5 + Math.abs(Math.sin(i * 3.7)) * 8, Math.cos(i * 5.31) * 40);
    dustGeos.push(g);
  }
  const dustMerged = mergeGeometries(dustGeos, false);
  for (const g of dustGeos) g.dispose();
  const dust = new THREE.Mesh(dustMerged!, makeInkMaterial(INK.BONE));
  dust.frustumCulled = false;
  T.group.add(dust);

  // ceilings: the rooms read as cut stone, not a night sky
  T.slab(-8, 30, 8, 44, 9.5, 0.5, INK.STONE, false);
  T.slab(-4, 12, 4, 30, 9.5, 0.5, INK.STONE, false);
  T.slab(-14, -10, 14, 12, 9.5, 0.5, INK.STONE, false);
  T.slab(-48, -8, -14, 10, 9.5, 0.5, INK.STONE, false);
  T.slab(14, -8, 48, 10, 9.5, 0.5, INK.STONE, false);
  T.slab(-4, -26, 4, -10, 9.5, 0.5, INK.STONE, false);
  T.slab(-16, -46, 16, -26, 9.5, 0.5, INK.STONE, false);
  T.slab(-10, -58, 10, -46, 9.5, 0.5, INK.STONE, false);
  T.flush();

  /* ------------------------------------------------------------------ *
   * travel volumes + per-frame animation
   * ------------------------------------------------------------------ */
  const map: EgyptMap = {
    zones,
    active: "surface",
    setZone(id) {
      map.active = id;
      for (const z of Object.values(zones)) z.group.visible = z.id === id;
    },
    floorY() {
      return zones[map.active].floorY;
    },
    nearest(p) {
      let best: Interaction | null = null;
      let bestD = Infinity;
      for (const it of interactions) {
        if (Math.abs(it.pos.y - p.y) > 2.6) continue;
        const d = Math.hypot(it.pos.x - p.x, it.pos.z - p.z);
        if (d > it.radius || d >= bestD) continue;
        if (!it.label()) continue;
        best = it;
        bestD = d;
      }
      const label = best?.label();
      return best && label ? { id: best.id, label } : null;
    },
    activate(id) {
      const it = interactions.find((i) => i.id === id);
      return it ? it.run() : null;
    },
    travelAt(p) {
      const active = zones[map.active];
      if (active.id === "surface") {
        if (!mainDoorOpen) return null;
        // the vestibule behind the great door: step through the threshold
        if (Math.abs(p.x) < 2.0 && p.z < 14.0 && p.z > 10.5) {
          return { zone: "interior", x: 0, y: -139.8, z: 13, yaw: 0 };
        }
      } else if (active.id === "interior") {
        if (!innerDoorOpen) return null;
        if (Math.abs(p.x) < 1.9 && p.z > 15.1) {
          return { zone: "surface", x: 0, y: 0.2, z: 21.5, yaw: Math.PI };
        }
      }
      return null;
    },
    hazard(p, now) {
      if (now < hurtUntil) return 0;
      // the valley floor is safe; the sanctuary and the tomb are not. A pit's
      // own y-window keeps the two buried areas from ever seeing each other.
      if (map.active === "surface") return 0;
      for (const pit of pits) {
        if (Math.abs(p.x - pit.x) > pit.w / 2 || Math.abs(p.z - pit.z) > pit.d / 2) continue;
        if (p.y > pit.baseY + 2.4 || p.y < pit.baseY - 1) continue;
        if (!pit.armed()) continue;
        const t = performance.now() * 0.001;
        const lift = Math.sin(t * 2.2 + pit.phase) * 0.5 + 0.5;
        if (lift > 0.55) {
          hurtUntil = now + 850;
          return 12;
        }
      }
      return 0;
    },
    update(t, dt, player) {
      for (const s of sliders) {
        const target = s.open() ? 1 : 0;
        s.k += (target - s.k) * Math.min(1, dt * 4);
        s.obj.position.copy(s.base).addScaledVector(s.dir, s.dist * s.k);
        // wait until the slab has actually cleared a standing body before the
        // collider goes, or the player walks through the stone as it moves
        if (s.collider && s.colliderLive && s.k > 0.9) {
          const owner = s.owner;
          if (owner) {
            const idx = owner.indexOf(s.collider);
            if (idx >= 0) owner.splice(idx, 1);
          }
          s.colliderLive = false;
        }
      }
      for (const h of hinges) {
        const target = h.open() ? 1 : 0;
        h.k += (target - h.k) * Math.min(1, dt * 5);
        h.obj.rotation.x = -1.15 * h.k;
      }
      for (const l of levers) {
        if (l.used()) l.obj.rotation.z = Math.min(1.2, l.obj.rotation.z + dt * 2.4);
      }
      for (const f of flames) {
        const w = Math.sin(t * 9 + f.phase) * 0.5 + Math.sin(t * 17 + f.phase * 2.1) * 0.5;
        f.flame.scale.set(0.72 + w * 0.16, 1.32 + w * 0.3, 0.72 + w * 0.16);
        f.glow.scale.setScalar(0.9 + w * 0.18);
        f.glow.position.y = f.flame.position.y - 0.02;
      }
      for (const pit of pits) {
        const lift = pit.armed() ? Math.sin(t * 2.2 + pit.phase) * 0.5 + 0.5 : 0;
        pit.group.position.y = pit.baseY + lift * 0.94;
      }
      dust.rotation.y = t * 0.01;
      dust.position.y = Math.sin(t * 0.2) * 0.3;
      let tip: string | undefined;
      if (map.active === "tomb" && !plateTriggered && Math.abs(player.x) < 1.5 && Math.abs(player.z - 2) < 1.5 && Math.abs(player.y + 300) < 1.4) {
        plateTriggered = true;
        gateOpen = true;
        if (t - lastPlateTip > 2) {
          lastPlateTip = t;
          tip = "<b>A DEEP CLUNK</b> · the sealed door rises";
        }
      }
      return { tip };
    },
  };

  for (const z of Object.values(zones)) scene.add(z.group);
  map.setZone("surface");
  return map;
}

/* ------------------------------------------------------------------ *
 * small composite props
 * ------------------------------------------------------------------ */

function ruin(z: Zone, x: number, zz: number) {
  z.box(x, 0, zz, 5, 0.4, 5, INK.STONE);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const px = x + Math.cos(a) * 1.8;
    const pz = zz + Math.sin(a) * 1.8;
    const h = i % 2 === 0 ? 2.4 : 1.4;
    z.cyl(px, 0.4, pz, 0.4, h, INK.SAND, false, true, 7);
    z.box(px, 0.4 + h, pz, 1.1, 0.28, 1.1, INK.OCHRE, false, false);
  }
  z.box(x + 2.2, 0, zz + 1.2, 1.2, 1.8, 3.4, INK.SAND);
  z.box(x - 1.6, 0, zz - 2.2, 2.6, 0.9, 1.1, INK.OCHRE);
  z.glyphs(x, 0.8, zz, "x", 3, 1.2, 2);
}

function makeMarket(z: Zone, x: number, zz: number) {
  tent(z, x, zz, INK.RED);
  tent(z, x + 7, zz - 3, INK.OCHRE);
  crate(z, x - 6.2, zz + 3.1);
  crate(z, x - 5.1, zz + 4.2, 0.78);
  z.box(x + 3.5, 0, zz + 2.4, 3.4, 0.8, 1.2, INK.OCHRE);
  z.box(x + 3.5, 0.8, zz + 2.4, 1.2, 0.5, 1.1, INK.TURQ, true, false);
  z.box(x - 4.4, 0, zz + 1.2, 1.4, 1.4, 1.4, INK.ORANGE);
  z.box(x - 3.1, 0, zz + 1.6, 1.0, 1.0, 1.0, INK.SAND);
  cactus(z, x + 9, zz + 4);
}

function makeCamp(z: Zone, x: number, zz: number) {
  crate(z, x + 1.6, zz + 3.2, 0.95);
  crate(z, x + 2.9, zz + 3.9, 0.7);
  z.box(x, 0, zz, 3.4, 0.18, 2.2, INK.OCHRE, false, false);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    z.box(x + 3.2 + Math.cos(a) * 0.7, 0, zz + Math.cos(a * 2) * 0.7, 0.24, 0.24, 0.24, INK.STONE, false, false);
  }
  z.sphere(x + 3.2, 0.2, zz, 0.5, INK.ORANGE, true, 0.7, 7);
  z.box(x - 2.6, 0, zz - 1.4, 1.6, 1.1, 1.6, INK.OCHRE);
  z.box(x - 2.6, 1.1, zz - 1.4, 1.2, 0.5, 1.2, INK.SAND);
}
