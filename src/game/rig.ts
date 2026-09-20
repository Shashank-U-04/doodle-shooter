// Enemy rigs — properly proportioned humanoids and creatures, drawn in ink.
//
// Two things changed from the earlier sphere-and-tube doodle people:
//   * anatomy. Shoulders, ribcage, pelvis, elbows, knees, ankles and a real
//     skull, at roughly 7.5 heads tall (~1.8m), so a figure reads as a person
//     from any distance instead of a stack of balls.
//   * kit. Each class wears gear that makes its silhouette readable: vests and
//     pouches, boots and gloves, helmets with visors, hoods and long coats,
//     shoulder armour, backpacks and tank rigs, ammo bandoliers, riot shields.
//
// Every limb is its own group (hips → torso → head / arms → forearms,
// hips → legs → shins) so the walk cycle can bend knees and elbows.
//
// Performance: a rig is ~50-80 primitives, so instead of one mesh each we merge
// every primitive that shares an ink and a fill mode into a single geometry per
// group. That keeps a whole enemy at ~20 draw calls despite the detail.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { INK, type InkId, makeInkMaterial } from "./world";

export type RigParts = {
  hips: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  foreL: THREE.Group;
  foreR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  gun: THREE.Group;
  shield: THREE.Group | null;
};

export type Rig = {
  root: THREE.Group;
  parts: RigParts;
  headWorldY: number;
  hitHeads: THREE.Object3D[];
};

export type RigStyle = {
  ink: InkId;
  accent?: InkId;
  bodyW: number;
  headS: number;
  limbR: number;
  scale: number;
  hat?: string;
  shield?: boolean;
  weapon?: string;
  vest?: boolean;
  coat?: boolean;
  visor?: boolean;
  bulky?: number;
  backpack?: string;
  smile?: boolean;
};

/* ------------------------------------------------------------------ *
 * geometry helpers: build in local space, bake the transform, bucket
 * by (ink, fill) so a whole group collapses into one mesh per material
 * ------------------------------------------------------------------ */

type Tf = {
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  sx?: number; sy?: number; sz?: number;
};
type Buckets = Map<string, { ink: InkId; fill: boolean; geos: THREE.BufferGeometry[] }>;

const tmpE = new THREE.Euler();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

function put(b: Buckets, geo: THREE.BufferGeometry, ink: InkId, fill: boolean, t: Tf) {
  tmpE.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0);
  tmpQ.setFromEuler(tmpE);
  tmpV.set(t.x ?? 0, t.y ?? 0, t.z ?? 0);
  tmpS.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  tmpM.compose(tmpV, tmpQ, tmpS);
  geo.applyMatrix4(tmpM);
  const k = `${ink}|${fill ? 1 : 0}`;
  const hit = b.get(k);
  if (hit) hit.geos.push(geo);
  else b.set(k, { ink, fill, geos: [geo] });
}

const bx = (b: Buckets, w: number, h: number, d: number, t: Tf, ink: InkId, fill = false) =>
  put(b, new THREE.BoxGeometry(w, h, d), ink, fill, t);
const cy = (b: Buckets, rt: number, rb: number, h: number, t: Tf, ink: InkId, fill = false, seg = 8) =>
  put(b, new THREE.CylinderGeometry(rt, rb, h, seg), ink, fill, t);
const sp = (b: Buckets, r: number, t: Tf, ink: InkId, fill = false, seg = 10) =>
  put(b, new THREE.SphereGeometry(r, seg, Math.max(4, Math.round(seg * 0.72))), ink, fill, t);
const tp = (b: Buckets, r: number, tube: number, t: Tf, ink: InkId, fill = false, arc = Math.PI * 2) =>
  put(b, new THREE.TorusGeometry(r, tube, 5, 14, arc), ink, fill, t);
const cn = (b: Buckets, r: number, h: number, t: Tf, ink: InkId, fill = false, seg = 6) =>
  put(b, new THREE.ConeGeometry(r, h, seg), ink, fill, t);

function flush(parent: THREE.Object3D, b: Buckets) {
  for (const { ink, fill, geos } of b.values()) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, makeInkMaterial(ink, fill));
    mesh.frustumCulled = false;
    parent.add(mesh);
    if (merged !== geos[0]) for (const g of geos) g.dispose();
  }
  b.clear();
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/* ------------------------------------------------------------------ *
 * shared body proportions (metres, root at the feet, ~1.8m tall)
 * ------------------------------------------------------------------ */

const HIP_Y = 0.92;
const THIGH = 0.44;
const FOOT = 0.13;
const SHOULDER_Y = 0.5;
const HEAD_Y = 0.64;
const UP_ARM = 0.3;
const FOREARM = 0.28;

/* ------------------------------------------------------------------ *
 * kit
 * ------------------------------------------------------------------ */

function buildHeadGear(b: Buckets, style: RigStyle, s: number) {
  const accent = style.accent ?? INK.BLACK;
  const hat = style.hat;
  if (!hat) return;
  if (hat === "cap") {
    cy(b, 0.132 * s, 0.142 * s, 0.1 * s, { y: 0.2 * s }, accent, true, 12);
    bx(b, 0.23 * s, 0.022 * s, 0.15 * s, { y: 0.163 * s, z: 0.1 * s, rx: -0.16 }, accent, true);
    bx(b, 0.2 * s, 0.02 * s, 0.09 * s, { y: 0.24 * s, z: 0.03 * s }, accent, true);
  } else if (hat === "helmet") {
    cy(b, 0.128 * s, 0.155 * s, 0.16 * s, { y: 0.19 * s, sz: 1.06 }, accent, true, 12);
    sp(b, 0.152 * s, { y: 0.24 * s, sy: 0.7, sz: 1.02 }, accent, true, 12);
    tp(b, 0.15 * s, 0.026 * s, { y: 0.13 * s, rx: Math.PI / 2, sz: 1.05 }, accent, true);
    // rear neck guard + chin strap
    bx(b, 0.2 * s, 0.09 * s, 0.05 * s, { y: 0.06 * s, z: -0.13 * s, rx: 0.35 }, accent, true);
    bx(b, 0.02 * s, 0.19 * s, 0.02 * s, { x: 0.085 * s, y: 0.02 * s, z: 0.02 * s }, accent, true);
    if (style.visor) {
      bx(b, 0.19 * s, 0.062 * s, 0.045 * s, { y: 0.135 * s, z: 0.105 * s, rx: -0.1 }, INK.BLACK, true);
      bx(b, 0.13 * s, 0.02 * s, 0.03 * s, { y: 0.135 * s, z: 0.128 * s }, INK.GREEN, true);
    }
  } else if (hat === "band") {
    tp(b, 0.122 * s, 0.026 * s, { y: 0.17 * s, rx: Math.PI / 2, sz: 1.04 }, accent, true);
    bx(b, 0.12 * s, 0.07 * s, 0.03 * s, { y: 0.09 * s, rx: 0.1, rz: 0.5, x: -0.09 * s }, accent, true);
    cn(b, 0.045 * s, 0.16 * s, { y: 0.28 * s, x: -0.02 * s, rz: 0.4 }, accent, true, 5);
    cn(b, 0.04 * s, 0.14 * s, { y: 0.27 * s, x: 0.04 * s, rz: -0.3 }, accent, true, 5);
  } else if (hat === "hood") {
    sp(b, 0.152 * s, { y: 0.13 * s, z: -0.02 * s, sy: 1.1, sz: 1.05 }, accent, true, 12);
    cn(b, 0.11 * s, 0.3 * s, { y: -0.05 * s, z: -0.16 * s, rx: -2.5 }, accent, true, 6);
    tp(b, 0.128 * s, 0.028 * s, { y: 0.12 * s, z: 0.06 * s, rx: 0.25, sz: 0.9 }, INK.BLACK, true, Math.PI * 1.1);
  } else if (hat === "crown") {
    tp(b, 0.121 * s, 0.024 * s, { y: 0.19 * s, rx: Math.PI / 2 }, INK.ORANGE, true);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      cn(b, 0.035 * s, 0.2 * s, { x: Math.cos(a) * 0.115 * s, y: 0.3 * s, z: Math.sin(a) * 0.115 * s }, INK.ORANGE, true, 4);
    }
  } else if (hat === "boonie") {
    cy(b, 0.135 * s, 0.128 * s, 0.1 * s, { y: 0.2 * s }, accent, true, 12);
    cy(b, 0.235 * s, 0.235 * s, 0.016 * s, { y: 0.152 * s }, accent, true, 14);
  }
}

/** long coat tails, bandolier, backpacks and shoulder armour */
function buildTorsoKit(b: Buckets, style: RigStyle, bw: number, bulky: number) {
  const accent = style.accent ?? INK.BLACK;
  if (style.vest) {
    // chest plate, back plate, shoulder straps, pouches
    bx(b, 0.3 * bw, 0.3, 0.075, { y: 0.36, z: 0.155 * bw }, accent, true);
    bx(b, 0.29 * bw, 0.27, 0.07, { y: 0.37, z: -0.15 * bw }, accent, true);
    bx(b, 0.075, 0.055, 0.32 * bw, { y: 0.5, x: -0.11 * bw, rz: 0.22 }, accent, true);
    bx(b, 0.075, 0.055, 0.32 * bw, { y: 0.5, x: 0.11 * bw, rz: -0.22 }, accent, true);
    bx(b, 0.1, 0.11, 0.055, { x: -0.13 * bw, y: 0.2, z: 0.12 * bw }, INK.ORANGE, true);
    bx(b, 0.1, 0.11, 0.055, { x: 0.13 * bw, y: 0.2, z: 0.12 * bw }, INK.ORANGE, true);
    bx(b, 0.085, 0.075, 0.03, { x: 0.02, y: 0.44, z: 0.165 * bw }, INK.GREEN, true);
  }
  if (style.backpack === "tank") {
    bx(b, 0.3 * bw, 0.36, 0.16, { y: 0.42, z: -0.28 * bw }, accent, true);
    cy(b, 0.075, 0.075, 0.34, { x: -0.085, y: 0.44, z: -0.38 * bw }, INK.ORANGE, true, 10);
    cy(b, 0.075, 0.075, 0.34, { x: 0.085, y: 0.44, z: -0.38 * bw }, INK.ORANGE, true, 10);
    tp(b, 0.06, 0.018, { y: 0.63, x: -0.085, z: -0.38 * bw, rz: Math.PI / 2 }, accent, true);
  } else if (style.backpack) {
    bx(b, 0.26 * bw, 0.3, 0.15, { y: 0.4, z: -0.26 * bw }, accent, true);
    bx(b, 0.2 * bw, 0.05, 0.04, { y: 0.52, z: -0.32 * bw }, INK.ORANGE, true);
    bx(b, 0.16 * bw, 0.09, 0.12, { y: 0.24, z: -0.3 * bw }, accent, true);
  }
  if (style.coat) {
    // coat tails and collar
    bx(b, 0.3 * bw, 0.62, 0.09, { y: 0.16, z: 0.14 * bw, rx: 0.06 }, accent, false);
    for (const side of [-1, 1]) {
      bx(b, 0.14 * bw, 0.66, 0.1, { x: side * 0.13 * bw, y: 0.14, z: -0.12 * bw, rx: -0.05, rz: side * 0.05 }, accent, false);
    }
    tp(b, 0.1 * bw, 0.03, { y: 0.58, rx: 1.5, sz: 0.7 }, accent, false);
  }
  if (bulky > 1.1) {
    // shoulder armour on the heavyweights
    for (const side of [-1, 1]) {
      sp(b, 0.115 * bw * bulky, { x: side * 0.21 * bw * bulky, y: 0.5, sx: 1.15, sy: 0.85 }, accent, true, 10);
      bx(b, 0.12, 0.05, 0.16, { x: side * 0.23 * bw * bulky, y: 0.44, rz: side * 0.3 }, accent, true);
    }
    // ammo bandolier
    for (let i = 0; i < 5; i++) {
      bx(b, 0.05, 0.075, 0.05, { x: -0.12 + i * 0.06, y: 0.3 - i * 0.055, z: 0.16 * bw, rz: -0.7 }, INK.ORANGE, true);
    }
  }
}

/* ------------------------------------------------------------------ *
 * weapons
 * ------------------------------------------------------------------ */

function buildGun(gun: THREE.Group, weapon: string | undefined, accent: InkId) {
  const b: Buckets = new Map();
  const metal = INK.BLACK;
  if (weapon === "blade") {
    // katana: wrapped grip, tsuba, long blade
    cy(b, 0.021, 0.021, 0.2, { y: 0.02, rz: Math.PI / 2, x: 0.1 }, metal, true, 8);
    for (let i = 0; i < 5; i++) bx(b, 0.012, 0.045, 0.045, { x: 0.03 + i * 0.035, z: 0 }, accent, true);
    cy(b, 0.05, 0.05, 0.02, { rz: Math.PI / 2, x: 0.21 }, INK.ORANGE, true, 12);
    bx(b, 0.62, 0.035, 0.012, { x: 0.55, rz: -0.04 }, metal, true);
    bx(b, 0.62, 0.014, 0.008, { x: 0.55, y: 0.022, rz: -0.04 }, accent, false);
  } else if (weapon === "shotgun") {
    cy(b, 0.026, 0.026, 0.52, { z: 0.34 }, metal, true, 10);
    cy(b, 0.022, 0.022, 0.42, { z: 0.3, y: -0.045 }, metal, true, 8);
    bx(b, 0.075, 0.11, 0.2, { z: 0.02, y: -0.02 }, metal, true);
    bx(b, 0.07, 0.07, 0.16, { z: -0.22, y: -0.05 }, accent, true);
    bx(b, 0.085, 0.14, 0.1, { z: 0.12, y: -0.11, rx: 0.25 }, INK.ORANGE, true);
    bx(b, 0.02, 0.05, 0.02, { z: 0.5, y: 0.035 }, INK.ORANGE, true);
  } else if (weapon === "sniper") {
    bx(b, 0.07, 0.1, 0.42, { z: 0.06 }, metal, true);
    cy(b, 0.018, 0.018, 0.9, { z: 0.72 }, metal, true, 8);
    cy(b, 0.03, 0.03, 0.1, { z: 1.2 }, metal, true, 8);
    bx(b, 0.045, 0.045, 0.3, { y: 0.085, z: 0.1 }, metal, true); // scope body
    cy(b, 0.038, 0.038, 0.03, { y: 0.085, z: 0.26, rx: Math.PI / 2 }, INK.GREEN, true, 10);
    cy(b, 0.038, 0.038, 0.03, { y: 0.085, z: -0.06, rx: Math.PI / 2 }, metal, true, 10);
    bx(b, 0.06, 0.16, 0.09, { z: -0.16, y: -0.08, rx: -0.2 }, accent, true);
    bx(b, 0.03, 0.1, 0.016, { z: 0.55, y: -0.08, rz: 0.5 }, metal, true);
    bx(b, 0.03, 0.1, 0.016, { z: 0.55, y: -0.08, rz: -0.5 }, metal, true);
  } else if (weapon === "pistol") {
    bx(b, 0.05, 0.075, 0.24, { z: 0.08 }, metal, true);
    cy(b, 0.013, 0.013, 0.1, { z: 0.23, rx: Math.PI / 2 }, metal, true, 8);
    bx(b, 0.048, 0.13, 0.075, { z: -0.02, y: -0.1, rx: -0.18 }, accent, true);
    bx(b, 0.056, 0.03, 0.11, { z: 0.03, y: 0.05 }, INK.ORANGE, true);
  } else if (weapon === "boss") {
    cy(b, 0.055, 0.07, 1.9, { y: 0.7 }, INK.ORANGE, false, 8);
    cn(b, 0.09, 0.34, { y: 1.72 }, metal, true, 6);
    sp(b, 0.075, { y: 1.94 }, INK.PINK, true, 8);
    tp(b, 0.075, 0.02, { y: 1.35, rx: Math.PI / 2 }, INK.BLACK, true);
    cy(b, 0.07, 0.07, 0.2, { y: -0.32 }, INK.PINK, true, 8);
  } else {
    // rifle: receiver, magazine, stock, barrel, handguard, optic, grip
    bx(b, 0.062, 0.1, 0.36, { z: 0.04 }, metal, true);
    bx(b, 0.05, 0.2, 0.075, { z: 0.02, y: -0.12, rx: 0.18 }, accent, true);
    cy(b, 0.014, 0.014, 0.4, { z: 0.5, rx: Math.PI / 2 }, metal, true, 8);
    bx(b, 0.055, 0.06, 0.24, { z: 0.36 }, accent, true);
    bx(b, 0.055, 0.05, 0.13, { z: -0.2, y: 0.01 }, metal, true);
    bx(b, 0.03, 0.045, 0.14, { y: 0.085, z: 0.06 }, metal, true);
    cy(b, 0.022, 0.022, 0.02, { y: 0.085, z: 0.14, rx: Math.PI / 2 }, INK.GREEN, true, 10);
    bx(b, 0.04, 0.11, 0.05, { z: -0.1, y: -0.07, rx: -0.25 }, metal, true);
    bx(b, 0.02, 0.03, 0.02, { z: 0.68, y: 0.03 }, INK.ORANGE, true);
  }
  flush(gun, b);
}

/* ------------------------------------------------------------------ *
 * the humanoid
 * ------------------------------------------------------------------ */

function buildHumanoid(style: RigStyle): Rig {
  const root = new THREE.Group();
  const ink = style.ink;
  const accent = style.accent ?? INK.BLACK;
  const bw = style.bodyW;
  const hs = style.headS;
  const bulky = style.bulky ?? 1;
  const thick = style.limbR / 0.032;
  const jitter = rnd(0.95, 1.06);

  const hipY = HIP_Y * jitter;
  const thighL = THIGH * jitter;
  const shinL = hipY - thighL - FOOT * jitter;

  const thighR = 0.098 * thick * Math.max(0.9, bw * 0.75 + 0.25);
  const shinR = 0.074 * thick * Math.max(0.9, bw * 0.75 + 0.25);
  const upR = 0.072 * thick * bulky;
  const foreR = 0.058 * thick * bulky;

  /* ---- hips / pelvis ---- */
  const hips = new THREE.Group();
  hips.position.y = hipY;
  root.add(hips);
  {
    const b: Buckets = new Map();
    cy(b, 0.152 * bw, 0.138 * bw, 0.24, { y: 0.02, sz: 0.8, sy: 1 }, ink);
    sp(b, thighR * 1.12, { x: -0.108 * bw, y: -0.04, sz: 0.95 }, ink, false, 8);
    sp(b, thighR * 1.12, { x: 0.108 * bw, y: -0.04, sz: 0.95 }, ink, false, 8);
    flush(hips, b);
    const k: Buckets = new Map();
    tp(k, 0.158 * bw, 0.028, { y: 0.11, rx: Math.PI / 2, sz: 0.82 }, accent, true);
    bx(k, 0.07, 0.055, 0.032, { y: 0.11, z: 0.126 * bw }, INK.ORANGE, true);
    flush(hips, k);
  }

  /* ---- torso: abdomen, ribcage, shoulders, neck ---- */
  const torso = new THREE.Group();
  hips.add(torso);
  {
    const b: Buckets = new Map();
    cy(b, 0.148 * bw, 0.136 * bw, 0.22, { y: 0.19, sz: 0.78 }, ink);
    cy(b, 0.186 * bw * bulky, 0.15 * bw, 0.26, { y: 0.42, sz: 0.7 }, ink);
    sp(b, 0.088 * bw * bulky, { x: -0.196 * bw * bulky, y: SHOULDER_Y, sy: 0.88, sz: 0.95 }, ink, false, 10);
    sp(b, 0.088 * bw * bulky, { x: 0.196 * bw * bulky, y: SHOULDER_Y, sy: 0.88, sz: 0.95 }, ink, false, 10);
    cy(b, 0.052, 0.06, 0.15, { y: 0.575, z: -0.005 }, ink);
    flush(torso, b);
    const k: Buckets = new Map();
    buildTorsoKit(k, style, bw, bulky);
    if (k.size) flush(torso, k);
  }

  /* ---- head ---- */
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  torso.add(head);
  {
    const s = hs;
    const b: Buckets = new Map();
    sp(b, 0.12 * s, { y: 0.1 * s, sx: 0.92, sy: 1.04, sz: 0.98 }, ink, false, 12);
    cy(b, 0.086 * s, 0.072 * s, 0.1 * s, { y: 0.03 * s, z: 0.012 * s, sz: 1.06 }, ink); // jaw
    sp(b, 0.032 * s, { x: -0.107 * s, y: 0.095 * s, z: -0.004 * s, sx: 0.5, sz: 0.9 }, ink, false, 7);
    sp(b, 0.032 * s, { x: 0.107 * s, y: 0.095 * s, z: -0.004 * s, sx: 0.5, sz: 0.9 }, ink, false, 7);
    bx(b, 0.176 * s, 0.03 * s, 0.05 * s, { y: 0.152 * s, z: 0.084 * s }, ink);
    cn(b, 0.026 * s, 0.072 * s, { y: 0.114 * s, z: 0.124 * s, rx: Math.PI / 2 }, ink, false, 5);
    flush(head, b);
    const f: Buckets = new Map();
    for (const side of [-1, 1]) {
      tp(f, 0.026 * s, 0.007 * s, { x: side * 0.052 * s, y: 0.142 * s, z: 0.104 * s }, INK.BLACK, false);
      sp(f, 0.018 * s, { x: side * 0.053 * s, y: 0.14 * s, z: 0.107 * s }, INK.BLACK, true, 6);
      bx(f, 0.064 * s, 0.017 * s, 0.022 * s, { x: side * 0.056 * s, y: 0.172 * s, z: 0.099 * s, rz: side * (style.smile ? -0.3 : 0.2) }, INK.BLACK, true);
    }
    if (style.smile) {
      tp(f, 0.04 * s, 0.009 * s, { y: 0.045 * s, z: 0.102 * s, rz: Math.PI }, INK.BLACK, true, Math.PI * 0.95);
    } else {
      bx(f, 0.062 * s, 0.014 * s, 0.022 * s, { y: 0.046 * s, z: 0.103 * s }, INK.BLACK, true);
    }
    flush(head, f);
    const h: Buckets = new Map();
    buildHeadGear(h, style, s);
    if (h.size) flush(head, h);
  }

  /* ---- arms ---- */
  const mkArm = (side: number) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.198 * bw * bulky, SHOULDER_Y - 0.015, 0);
    torso.add(arm);
    {
      const b: Buckets = new Map();
      sp(b, upR * 1.2, { x: side * upR * 0.5, sy: 0.92, sz: 0.95 }, ink, false, 8);
      cy(b, upR * 0.94, upR * 0.86, UP_ARM, { y: -UP_ARM * 0.5 - 0.02, z: -0.004 }, ink);
      flush(arm, b);
    }
    const fore = new THREE.Group();
    fore.position.y = -UP_ARM;
    arm.add(fore);
    {
      const b: Buckets = new Map();
      cy(b, foreR, foreR * 0.84, FOREARM, { y: -FOREARM * 0.5 }, ink);
      flush(fore, b);
      const k: Buckets = new Map();
      // elbow pad, glove and fist
      sp(k, foreR * 1.1, { y: 0.005, sy: 0.75 }, accent, true, 8);
      bx(k, 0.088, 0.1, 0.09, { y: -FOREARM - 0.04 }, accent, true);
      bx(k, 0.082, 0.036, 0.1, { y: -FOREARM - 0.07, z: 0.025 }, accent, true);
      bx(k, 0.075, 0.05, 0.03, { y: -FOREARM - 0.02, z: 0.05 }, accent, true);
      flush(fore, k);
    }
    return { arm, fore };
  };
  const L = mkArm(-1);
  const R = mkArm(1);

  const gun = new THREE.Group();
  gun.position.set(0, -FOREARM - 0.06, 0.04);
  R.fore.add(gun);
  buildGun(gun, style.weapon, accent);

  /* ---- legs ---- */
  const mkLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.108 * bw, -0.01, 0);
    hips.add(leg);
    {
      const b: Buckets = new Map();
      cy(b, thighR, thighR * 0.85, thighL, { y: -thighL * 0.5 - 0.02, z: -0.004 }, ink);
      flush(leg, b);
    }
    const shin = new THREE.Group();
    shin.position.y = -thighL;
    leg.add(shin);
    {
      const b: Buckets = new Map();
      cy(b, shinR, shinR * 0.74, shinL, { y: -shinL * 0.5 }, ink);
      flush(shin, b);
      const k: Buckets = new Map();
      // knee pad + boot: ankle, foot, toe, sole
      sp(k, shinR * 1.05, { y: 0.01, z: 0.02, sy: 0.8 }, accent, true, 8);
      cy(k, shinR * 1.05, shinR * 1.05, 0.11, { y: -shinL + 0.05 }, accent, true, 8);
      bx(k, 0.135 * thick, 0.115, 0.2, { y: -shinL - 0.05, z: 0.038 }, accent, true);
      bx(k, 0.12 * thick, 0.075, 0.06, { y: -shinL - 0.075, z: 0.15 }, accent, true);
      bx(k, 0.15 * thick, 0.038, 0.28, { y: -shinL - 0.122, z: 0.045 }, INK.BLACK, true);
      flush(shin, k);
    }
    return { leg, shin };
  };
  const LL = mkLeg(-1);
  const RL = mkLeg(1);

  /* ---- riot shield, carried on the left forearm ---- */
  let shield: THREE.Group | null = null;
  if (style.shield) {
    shield = new THREE.Group();
    shield.position.set(-0.02, -FOREARM * 0.55, 0.02);
    L.fore.add(shield);
    const b: Buckets = new Map();
    bx(b, 0.66, 1.06, 0.05, { x: -0.04 }, accent, true);
    bx(b, 0.7, 0.1, 0.06, { x: -0.04, y: 0.42 }, INK.BLACK, true);
    bx(b, 0.7, 0.1, 0.06, { x: -0.04, y: -0.42 }, INK.BLACK, true);
    bx(b, 0.06, 1.02, 0.062, { x: -0.04, z: 0.004 }, INK.BLACK, true);
    cy(b, 0.15, 0.15, 0.02, { x: -0.04, z: 0.035, rx: Math.PI / 2 }, INK.RED, true, 14);
    bx(b, 0.26, 0.075, 0.03, { x: -0.04, y: 0.1, z: 0.036 }, INK.RED, true);
    flush(shield, b);
  }

  root.scale.setScalar(style.scale);

  return {
    root,
    parts: {
      hips, torso, head,
      armL: L.arm, armR: R.arm,
      foreL: L.fore, foreR: R.fore,
      legL: LL.leg, legR: RL.leg,
      shinL: LL.shin, shinR: RL.shin,
      gun, shield,
    },
    headWorldY: (hipY + HEAD_Y + 0.1 * hs) * style.scale,
    hitHeads: [head],
  };
}

/* ------------------------------------------------------------------ *
 * makers
 * ------------------------------------------------------------------ */

export function makeRig(style: RigStyle): Rig {
  return buildHumanoid(style);
}

/* ---------- blobs: the ink bombs and the two blob bosses ---------- */

export function makeBlobRig(style: RigStyle, bossKind?: string): Rig {
  const root = new THREE.Group();
  const ink = style.ink;
  const accent = style.accent ?? INK.BLACK;

  const hips = new THREE.Group();
  hips.position.y = 0.56;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);

  const head = new THREE.Group();
  head.position.y = 0.3;
  torso.add(head);

  {
    const b: Buckets = new Map();
    if (bossKind === "eraser") {
      // a real rubber eraser: a slab body, a paper sleeve, a worn corner
      bx(b, 0.94, 0.46, 0.62, { y: 0.3, rz: 0.02 }, ink, false);
      bx(b, 0.99, 0.1, 0.66, { y: 0.5, rz: 0.02 }, ink, false);
      bx(b, 0.9, 0.36, 0.64, { y: 0.36, z: -0.03 }, ink, false);
      flush(torso, b);
      const k: Buckets = new Map();
      bx(k, 0.96, 0.24, 0.66, { y: 0.34 }, INK.BLACK, true);
      bx(k, 0.4, 0.13, 0.02, { y: 0.34, z: 0.34 }, INK.ORANGE, true);
      bx(k, 0.16, 0.05, 0.015, { y: 0.28, z: 0.345 }, INK.BLACK, true);
      bx(k, 0.86, 0.1, 0.6, { y: 0.08, z: -0.02, rz: -0.04 }, ink, true);
      flush(torso, k);
    } else if (bossKind === "inkblot") {
      sp(b, 0.46, { y: 0.34, sy: 0.86, sz: 0.92 }, ink, false, 14);
      sp(b, 0.3, { y: 0.62, z: 0.16, sy: 0.7 }, ink, false, 12);
      sp(b, 0.63, { y: 0.22, sy: 0.62, sz: 1.02 }, ink, false, 14);
      flush(torso, b);
      const k: Buckets = new Map();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        const r = 0.44 + Math.sin(i * 2.1) * 0.06;
        cn(k, 0.115, 0.46, { x: Math.cos(a) * r, y: 0.34 + Math.sin(a * 2.3) * 0.22, z: Math.sin(a) * r, rx: Math.PI / 2, ry: 0, rz: 0.4 }, ink, true, 5);
      }
      // drips
      for (const [x, z, s] of [[-0.4, 0.3, 1], [0.44, -0.24, 0.8], [0.1, 0.46, 0.9]] as const) {
        cy(k, 0.03 * s, 0.09 * s, 0.26 * s, { x, y: 0.02, z }, ink, true, 6);
        sp(k, 0.09 * s, { x, y: -0.12 * s, z }, ink, true, 8);
      }
      flush(torso, k);
      const f: Buckets = new Map();
      for (const side of [-1, 1]) {
        sp(f, 0.05, { x: side * 0.16, y: 0.42, z: 0.42 }, INK.BLACK, true, 7);
        bx(f, 0.15, 0.03, 0.02, { x: side * 0.17, y: 0.53, z: 0.4, rz: side * 0.35 }, INK.BLACK, true);
      }
      bx(f, 0.28, 0.05, 0.02, { y: 0.2, z: 0.46 }, INK.BLACK, true);
      flush(head, f);
    } else {
      // INK BOMB: a fat pressurised blob with a fuse and a valve
      sp(b, 0.4, { y: 0.36, sy: 0.98, sz: 0.98 }, ink, false, 14);
      sp(b, 0.3, { y: 0.1, sy: 0.7, sz: 1.0 }, ink, false, 12);
      flush(torso, b);
      const k: Buckets = new Map();
      tp(k, 0.4, 0.05, { y: 0.36, rx: Math.PI / 2 }, ink, true);
      cy(k, 0.1, 0.13, 0.16, { y: 0.78 }, accent, true, 10);
      cy(k, 0.035, 0.035, 0.3, { y: 0.95, x: 0.02, rz: 0.25 }, accent, true, 8);
      sp(k, 0.075, { y: 1.12, x: 0.09 }, INK.ORANGE, true, 8);
      for (const [x, z] of [[-0.26, 0.24], [0.28, -0.2], [0.02, -0.4]] as const) {
        sp(k, 0.07, { x, y: 0.12, z }, accent, true, 8);
      }
      flush(torso, k);
      const f: Buckets = new Map();
      for (const side of [-1, 1]) {
        sp(f, 0.052, { x: side * 0.15, y: 0.44, z: 0.34 }, INK.BLACK, true, 7);
        bx(f, 0.16, 0.03, 0.02, { x: side * 0.16, y: 0.55, z: 0.33, rz: side * 0.4 }, INK.BLACK, true);
      }
      bx(f, 0.17, 0.05, 0.02, { y: 0.24, z: 0.37 }, INK.BLACK, true);
      flush(head, f);
    }
  }

  // stubby arms and legs with mitts and boots
  const mkLimb = (parent: THREE.Object3D, x: number, y: number, len: number, r: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    parent.add(g);
    const b: Buckets = new Map();
    cy(b, r, r * 0.85, len, { y: -len * 0.5 }, style.ink);
    flush(g, b);
    return g;
  };
  const armL = mkLimb(torso, -0.44, 0.42, 0.28, 0.045);
  const armR = mkLimb(torso, 0.44, 0.42, 0.28, 0.045);
  const legL = mkLimb(hips, -0.18, -0.02, 0.42, 0.05);
  const legR = mkLimb(hips, 0.18, -0.02, 0.42, 0.05);
  for (const [g, kind] of [[armL, "hand"], [armR, "hand"], [legL, "foot"], [legR, "foot"]] as const) {
    const b: Buckets = new Map();
    if (kind === "hand") sp(b, 0.085, { y: -0.3, sy: 0.9 }, INK.BLACK, true, 8);
    else {
      bx(b, 0.16, 0.14, 0.26, { y: -0.44, z: 0.04 }, INK.BLACK, true);
    }
    flush(g, b);
  }

  const gun = new THREE.Group();
  root.add(gun);
  root.scale.setScalar(style.scale);

  return {
    root,
    parts: {
      hips, torso, head,
      armL, armR, foreL: armL, foreR: armR,
      legL, legR, shinL: legL, shinR: legR,
      gun, shield: null,
    },
    headWorldY: (0.56 + 0.36) * style.scale,
    hitHeads: [torso],
  };
}

/* ---------- paper wasp: a real insect build ---------- */

export function makeWaspRig(style: RigStyle): Rig {
  const root = new THREE.Group();
  const ink = style.ink;
  const black = INK.BLACK;

  const hips = new THREE.Group();
  hips.position.y = 0.5;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);

  const head = new THREE.Group();
  head.position.set(0, 0.06, 0.42);
  torso.add(head);

  {
    const b: Buckets = new Map();
    // abdomen with wasp bands, thorax, head, stinger
    sp(b, 0.3, { y: 0.02, z: -0.42, sx: 0.92, sy: 0.92, sz: 1.5 }, ink, false, 12);
    sp(b, 0.24, { y: 0.06, z: 0.06, sy: 1.0, sz: 1.0 }, ink, false, 12);
    sp(b, 0.2, { y: 0.06, z: 0.44, sx: 0.94, sy: 1.0, sz: 1.05 }, ink, false, 12);
    flush(torso, b);
    const k: Buckets = new Map();
    for (const z of [-0.72, -0.5, -0.28]) {
      sp(k, 0.3, { y: 0.02, z, sx: 0.93, sy: 0.94, sz: 0.16 }, black, true, 12);
    }
    sp(k, 0.06, { y: 0.06, z: 0.68, sx: 0.9, sy: 0.9 }, black, true, 8);
    cn(k, 0.07, 0.34, { y: 0.02, z: -0.98, rx: -Math.PI / 2, ry: 0 }, black, true, 6);
    // antennae
    for (const side of [-1, 1]) {
      cy(k, 0.016, 0.012, 0.3, { x: side * 0.09, y: 0.14, z: 0.66, rx: 1.1, rz: side * 0.4 }, black, true, 6);
      sp(k, 0.03, { x: side * 0.17, y: 0.28, z: 0.78 }, black, true, 6);
      // compound eyes + mandibles
      sp(k, 0.085, { x: side * 0.14, y: 0.08, z: 0.56, sx: 0.7 }, INK.GREEN, true, 8);
      cn(k, 0.03, 0.1, { x: side * 0.06, y: -0.1, z: 0.62, rx: 2.4 }, black, true, 5);
    }
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = [-0.1, 0.06, 0.24][Math.floor(i / 2)];
      cy(k, 0.026, 0.018, 0.42, { x: side * 0.2, y: -0.2, z, rz: side * 0.5, rx: 0.3 }, black, true, 6);
      cy(k, 0.018, 0.012, 0.34, { x: side * 0.42, y: -0.46, z: z + 0.14, rz: side * 1.0, rx: 0.9 }, black, true, 6);
    }
    flush(torso, k);
  }

  // four paper wings
  const wings: THREE.Group[] = [];
  {
    const b: Buckets = new Map();
    flush(torso, b);
  }
  for (let i = 0; i < 4; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const g = new THREE.Group();
    g.position.set(side * 0.2, 0.18, i < 2 ? 0.1 : -0.05);
    torso.add(g);
    const b: Buckets = new Map();
    sp(b, 0.34, { x: side * 0.34, y: 0.06, z: -0.1, sx: 1.1, sy: 0.06, sz: 0.55 }, ink, false, 10);
    for (let n = 0; n < 3; n++) {
      cy(b, 0.012, 0.008, 0.5, { x: side * 0.34, y: 0.07, z: -0.28 + n * 0.12, rz: Math.PI / 2, ry: 0.5 * side }, black, false, 5);
    }
    flush(g, b);
    wings.push(g);
  }

  const gun = new THREE.Group();
  root.add(gun);
  root.scale.setScalar(style.scale);
  return {
    root,
    parts: {
      hips, torso, head,
      armL: torso, armR: torso, foreL: torso, foreR: torso,
      legL: hips, legR: hips, shinL: hips, shinR: hips,
      gun, shield: null,
    },
    headWorldY: (0.5 + 0.06) * style.scale,
    hitHeads: [torso],
  };
}
