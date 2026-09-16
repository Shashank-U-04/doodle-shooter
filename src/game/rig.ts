// Sketchy enemy rigs matching the original's "doodle people":
// bezier-tube limbs with sphere hands/feet, sphere torso + head, cartoon face
// (eyes + brows + torus mouth), hats (cap/band/helmet/hood/crown), and the
// right little gun for each weapon type. Proportions follow the original's rig.

import * as THREE from "three";
import { INK, type InkId, makeInkMaterial } from "./world";

const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

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
  bodyW: number;
  headS: number;
  limbR: number;
  hat?: string;
  shield?: boolean;
  weapon?: string;
  scale: number;
  smile?: boolean;
};

const tubeLimb = (
  parent: THREE.Object3D,
  len: number,
  r: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Group => {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  const curve = new THREE.QuadraticBezierCurve3(V3(0, 0, 0), V3(rnd(-0.05, 0.05), -len * 0.5, rnd(-0.05, 0.05) + 0.03), V3(0, -len, 0));
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 5, r, 6, false), mat));
  const mid = new THREE.Object3D();
  mid.position.y = -len * 0.55;
  g.add(mid);
  g.userData.mid = mid;
  g.userData.len = len;
  return g;
};

const blob = (
  parent: THREE.Object3D,
  sx: number,
  sy: number,
  sz: number,
  x: number,
  y: number,
  z: number,
  mat: THREE.Material,
): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
};

const knob = (
  parent: THREE.Object3D,
  r: number,
  y: number,
  mat: THREE.Material,
  stretchY = 1.15,
): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 5), mat);
  m.position.y = y;
  m.scale.set(1, stretchY, 0.8);
  parent.add(m);
  return m;
};

function buildFace(head: THREE.Object3D, inkLine: THREE.Material, inkFill: THREE.Material, smile: boolean) {
  const g = new THREE.Group();
  head.add(g);
  for (const side of [-1, 1]) {
    const eye = blob(g, 0.045, 0.055, 0.035, side * 0.1, 0.03, 0.25, inkFill);
    eye.scale.multiply(new THREE.Vector3(0.85, 1.15, 0.7));
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.026, 0.026), inkLine);
    brow.position.set(side * 0.1, 0.11, 0.24);
    brow.rotation.z = side * -0.5;
    g.add(brow);
  }
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.018, 4, 9, Math.PI * 0.9), inkLine);
  mouth.position.set(0, -0.16, 0.23);
  mouth.rotation.z = smile ? Math.PI : 0;
  g.add(mouth);
}

function buildHat(hatG: THREE.Object3D, inkLine: THREE.Material, inkFill: THREE.Material, hat?: string) {
  if (!hat) return;
  if (hat === "cap") {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.29, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5), inkFill);
    dome.position.y = 0.05;
    dome.scale.y = 0.62;
    hatG.add(dome);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 0.24), inkFill);
    brim.position.set(0, 0.05, 0.24);
    brim.rotation.x = -0.18;
    hatG.add(brim);
  } else if (hat === "band") {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.028, 5, 14), inkFill);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.11;
    hatG.add(band);
    for (let i = 0; i < 4; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.2, 4), inkFill);
      spike.position.set(-0.12 + i * 0.08, 0.28, 0.02);
      spike.rotation.z = (i - 1.5) * 0.35;
      hatG.add(spike);
    }
  } else if (hat === "helmet") {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), inkFill);
    dome.position.y = 0;
    dome.scale.y = 0.85;
    hatG.add(dome);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.315, 0.03, 4, 14), inkFill);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -0.02;
    hatG.add(rim);
  } else if (hat === "hood") {
    const hood = new THREE.Mesh(new THREE.SphereGeometry(0.33, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62), inkFill);
    hood.position.y = -0.02;
    hood.scale.set(1.03, 1.15, 0.95);
    hatG.add(hood);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5, 5), inkFill);
    tip.position.set(0, 0.16, -0.3);
    tip.rotation.x = 1.5;
    hatG.add(tip);
  } else if (hat === "crown") {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.26, 4), inkFill);
      spike.position.set(Math.cos(a) * 0.22, 0.34, Math.sin(a) * 0.22);
      hatG.add(spike);
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.035, 4, 14), inkFill);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.24;
    hatG.add(band);
  }
}

function buildGun(gun: THREE.Group, inkLine: THREE.Material, inkFill: THREE.Material, inkOrange: THREE.Material, inkPink: THREE.Material, weapon?: string) {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    gun.add(mesh);
    return mesh;
  };
  const cyl = (r: number, len: number, x: number, y: number, z: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    gun.add(mesh);
    return mesh;
  };
  if (weapon === "blade") {
    box(0.02, 0.05, 0.95, 0, 0.04, 0.42, inkFill);
    box(0.11, 0.11, 0.03, 0, 0.04, -0.06, inkLine);
    box(0.035, 0.045, 0.24, 0, 0.04, -0.19, inkLine);
  } else if (weapon === "shotgun") {
    box(0.1, 0.13, 0.66, 0, 0.02, 0.2, inkLine);
    cyl(0.035, 0.5, 0, 0.08, 0.5, inkFill);
  } else if (weapon === "sniper") {
    box(0.075, 0.11, 0.6, 0, 0.02, 0.15, inkLine);
    cyl(0.025, 0.95, 0, 0.05, 0.72, inkFill);
    box(0.06, 0.07, 0.22, 0, 0.13, 0.06, inkLine);
  } else if (weapon === "pistol") {
    box(0.055, 0.09, 0.3, 0, 0.03, 0.13, inkLine);
    box(0.045, 0.11, 0.055, 0, -0.05, 0, inkFill);
  } else if (weapon === "boss") {
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.4, 7), inkOrange);
    staff.position.y = 0.7;
    gun.add(staff);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.38, 6), inkLine);
    tip.position.y = 2.08;
    gun.add(tip);
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.26, 8), inkPink);
    butt.position.y = -0.62;
    gun.add(butt);
  } else {
    // rifle
    box(0.085, 0.12, 0.5, 0, 0.02, 0.16, inkLine);
    cyl(0.022, 0.34, 0, 0.05, 0.52, inkFill);
    box(0.05, 0.16, 0.09, 0, -0.09, 0.08, inkLine);
  }
}

export function makeRig(style: RigStyle): Rig {
  const root = new THREE.Group();
  const line = makeInkMaterial(style.ink, false);
  const fill = makeInkMaterial(style.ink, true);
  const black = makeInkMaterial(INK.BLACK, false);
  const orange = makeInkMaterial(INK.ORANGE, false);
  const pink = makeInkMaterial(INK.PINK, false);

  const bw = style.bodyW;
  const hs = style.headS;
  const lr = style.limbR;
  const bodyH = rnd(0.95, 1.06); // per-enemy height jitter, like the original

  const hips = new THREE.Group();
  hips.position.y = 0.86;
  root.add(hips);

  const torso = new THREE.Group();
  hips.add(torso);
  blob(torso, 0.3 * bw, 0.3, 0.19 * bw, 0, 0.26, 0, line);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.12, 6), line);
  neck.position.y = 0.56;
  torso.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.62;
  torso.add(head);
  blob(head, 0.275 * hs * bodyH, 0.3 * hs, 0.25 * hs, 0, 0.26, 0, line);
  const faceG = new THREE.Group();
  faceG.position.y = 0.26;
  faceG.scale.setScalar(hs);
  head.add(faceG);
  buildFace(faceG, black, fill, style.smile ?? style.weapon === "blade");
  const hatG = new THREE.Group();
  hatG.position.y = 0.26;
  hatG.scale.setScalar(hs);
  head.add(hatG);
  buildHat(hatG, black, fill, style.hat);

  // arms
  const armL = tubeLimb(torso, 0.42, lr * 1.15, line, -0.13 * bw, -0.02, 0);
  const armR = tubeLimb(torso, 0.42, lr * 1.15, line, 0.13 * bw, -0.02, 0);
  knob(armL, lr * 2.3, -0.42, fill);
  knob(armR, lr * 2.3, -0.42, fill);

  // legs (from hips)
  const legL = tubeLimb(hips, 0.3, lr, line, -0.26 * bw, 0.04, 0);
  const legR = tubeLimb(hips, 0.3, lr, line, 0.26 * bw, 0.04, 0);
  knob(legL, lr * 2.2, -0.3, fill);
  knob(legR, lr * 2.2, -0.3, fill);

  // gun in right hand
  const gun = new THREE.Group();
  gun.position.set(0, -0.29, 0.07);
  armR.add(gun);
  buildGun(gun, black, fill, orange, pink, style.weapon);

  // shield (front plate on torso group, like original)
  let shield: THREE.Group | null = null;
  if (style.shield) {
    shield = new THREE.Group();
    shield.position.set(-0.17, 0.34, 0.46);
    torso.add(shield);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.3, 0.07), fill);
    shield.add(plate);
    const barH = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.09), black);
    barH.position.set(0, 0.26, 0.04);
    shield.add(barH);
    const barV = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.09), black);
    barV.position.set(0, 0.26, 0.04);
    shield.add(barV);
  }

  root.scale.setScalar(style.scale);

  return {
    root,
    parts: { hips, torso, head, armL, armR, foreL: armL, foreR: armR, legL, legR, shinL: legL, shinR: legR, gun, shield },
    headWorldY: (0.86 + 0.62 + 0.26) * style.scale,
    hitHeads: [head],
  };
}

/* ---------- blob / wasp rigs ---------- */

export function makeBlobRig(style: RigStyle, bossKind?: string): Rig {
  const root = new THREE.Group();
  const line = makeInkMaterial(style.ink, false);
  const fill = makeInkMaterial(style.ink, true);
  const black = makeInkMaterial(INK.BLACK, false);
  const orange = makeInkMaterial(INK.ORANGE, false);
  const pink = makeInkMaterial(INK.PINK, false);

  const hips = new THREE.Group();
  hips.position.y = 0.5;
  root.add(hips);
  const torso = new THREE.Group();
  hips.add(torso);
  blob(torso, 0.44, 0.44, 0.44, 0, 0.32, 0, line);

  const head = new THREE.Group();
  head.position.y = 0.32;
  torso.add(head);
  const faceG = new THREE.Group();
  faceG.position.set(0, 0.1, 0.3);
  head.add(faceG);
  buildFace(faceG, black, fill, false);

  if (bossKind === "inkblot") {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 5), line);
      spike.position.set(Math.cos(a) * 0.42, 0.32 + Math.sin(a * 2.3) * 0.25, Math.sin(a) * 0.42);
      spike.lookAt(Math.cos(a) * 3, 0.32, Math.sin(a) * 3);
      spike.rotateX(Math.PI / 2);
      torso.add(spike);
    }
  } else if (bossKind === "eraser") {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.5), line);
    shoe.position.set(0, 0.86, 0);
    torso.add(shoe);
    const sole = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.05, 0.54), black);
    sole.position.set(0, 0.7, 0);
    torso.add(sole);
  } else {
    // doodler: little bulb on a wire
    const bulbWire = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.14, 7), line);
    bulbWire.position.y = 0.76;
    torso.add(bulbWire);
    const wire = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(V3(0, 0.8, 0), V3(0.16, 1, 0), V3(0.24, 1.14, 0)), 5, 0.02, 5, false),
      line,
    );
    torso.add(wire);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), orange);
    bulb.position.set(0.24, 1.14, 0);
    torso.add(bulb);
  }

  // stubby arms + legs
  const armL = tubeLimb(torso, 0.26, 0.03, line, -0.42, 0.42, 0);
  const armR = tubeLimb(torso, 0.26, 0.03, line, 0.42, 0.42, 0);
  knob(armL, 0.07, -0.26, fill);
  knob(armR, 0.07, -0.26, fill);
  const legL = tubeLimb(hips, 0.26, 0.035, line, -0.16, -0.06, 0);
  const legR = tubeLimb(hips, 0.26, 0.035, line, 0.16, -0.06, 0);
  const footL = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 5), line);
  footL.position.set(0, -0.24, 0.06 * 0.9);
  footL.scale.set(1, 0.62, 1.9);
  legL.add(footL);
  const footR = footL.clone();
  legR.add(footR);
  void pink;

  const gun = new THREE.Group();
  root.add(gun);

  root.scale.setScalar(style.scale);
  return {
    root,
    parts: { hips, torso, head, armL, armR, foreL: armL, foreR: armR, legL, legR, shinL: legL, shinR: legR, gun, shield: null },
    headWorldY: (0.5 + 0.32 + 0.3) * style.scale,
    hitHeads: [torso],
  };
}

export function makeWaspRig(style: RigStyle): Rig {
  const root = new THREE.Group();
  const line = makeInkMaterial(style.ink, false);
  const fill = makeInkMaterial(style.ink, true);
  const black = makeInkMaterial(INK.BLACK, false);

  const hips = new THREE.Group();
  hips.position.y = 0.5;
  root.add(hips);
  const torso = new THREE.Group();
  hips.add(torso);
  // striped wasp body: stacked spheres
  blob(torso, 0.3, 0.3, 0.42, 0, 0.3, 0, line);
  const stripe1 = blob(torso, 0.31, 0.08, 0.43, 0, 0.38, 0, black);
  void stripe1;
  const stripe2 = blob(torso, 0.31, 0.08, 0.43, 0, 0.22, 0, black);
  void stripe2;
  blob(torso, 0.2, 0.2, 0.24, 0, 0.34, 0.42, line); // head
  const stinger = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 5), black);
  stinger.rotation.x = -Math.PI / 2;
  stinger.position.set(0, 0.3, -0.55);
  torso.add(stinger);
  // wings
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 5), line);
    wing.scale.set(1.1, 0.05, 0.5);
    wing.position.set(side * 0.28, 0.55, 0.05);
    wing.rotation.z = side * 0.35;
    torso.add(wing);
  }
  const faceG = new THREE.Group();
  faceG.position.set(0, 0.36, 0.62);
  root.add(faceG);
  buildFace(faceG, black, fill, true);

  const gun = new THREE.Group();
  root.add(gun);
  root.scale.setScalar(style.scale);
  return {
    root,
    parts: { hips, torso, head: torso, armL: torso, armR: torso, foreL: torso, foreR: torso, legL: hips, legR: hips, shinL: hips, shinR: hips, gun, shield: null },
    headWorldY: (0.5 + 0.34) * style.scale,
    hitHeads: [torso],
  };
}
