// Doodle District — single-player wave-survival FPS engine (faithful re-creation).
// First-person survival inside a hand-sketched town: toon-shaded boxes on paper with
// real-time ink outlines, wave modifiers, bosses every 5 waves, katana focus meter,
// grapple, grenades, and pickups.

import * as THREE from "three";
import { AudioFX } from "./audio";
import { PAPER_FRAG } from "./shaders";
import {
  INK,
  PAPER,
  makeInkMaterial,
  resolveMove,
  type Collider,
  type InkId,
} from "./world";
import { buildDistrict, type District } from "./district";
import { makeBlobRig, makeRig, makeWaspRig, type Rig } from "./rig";
import { ED, PR, QR, VR, XN, XN_AIR, CI, JN, BASE_FOV, type EnemyKind, type EnemyDef } from "./enemies-data";
import type { EngineCallbacks, GameHandle, HudState } from "./types";

THREE.ColorManagement.enabled = false;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
type EnemyDefX = { bodyW?: number; headS?: number; limbR?: number };
type Enemy = {
  kind: EnemyKind;
  def: EnemyDef;
  root: THREE.Group;
  head: THREE.Object3D;
  torso: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  hatMesh: THREE.Object3D | null;
  shieldMesh: THREE.Object3D | null;
  headY: number;
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

/* ============================== data ============================== */

type WeaponDef = {
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

const WEAPONS: WeaponDef[] = [
  { name: "RIFLE", kind: "rifle", hint: "auto · put the red dot on them", magSize: 35, reserve: 175, maxReserve: 350, interval: 1 / 11, damage: 24, headMul: 2.6, pellets: 1, spread: 0.016, adsSpread: 0.0034, reloadTime: 1.45, auto: true, zoom: 58 },
  { name: "SHOTGUN", kind: "shotgun", hint: "pump · devastating up close", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.78, damage: 19, headMul: 1.8, pellets: 10, spread: 0.062, adsSpread: 0.034, reloadTime: 2.0, auto: false, zoom: 68 },
  { name: "SNIPER", kind: "sniper", hint: "scoped bolt action · one shot, one erasure", magSize: 5, reserve: 25, maxReserve: 50, interval: 0.9, damage: 150, headMul: 3, pellets: 1, spread: 0.075, adsSpread: 0.0004, reloadTime: 2.1, auto: false, zoom: 20 },
  { name: "KATANA", kind: "katana", hint: "slash · hold aim to block & return bullets", magSize: Infinity, reserve: Infinity, maxReserve: Infinity, interval: 0.27, damage: 75, headMul: 1.6, pellets: 1, spread: 0, adsSpread: 0, reloadTime: 0, auto: false, zoom: 82, katana: true },
  { name: "REVOLVER", kind: "revolver", hint: "hand cannon · headshots erase", magSize: 6, reserve: 36, maxReserve: 72, interval: 0.3, damage: 62, headMul: 3, pellets: 1, spread: 0.006, adsSpread: 0.002, reloadTime: 1.9, auto: false, zoom: 52 },
];

const SPAWN_TABLE: { t: EnemyKind; from: number; w: number }[] = [
  { t: "grunt", from: 1, w: 10 },
  { t: "rusher", from: 2, w: 6 },
  { t: "bomber", from: 3, w: 3 },
  { t: "sniper", from: 3, w: 4 },
  { t: "flyer", from: 4, w: 4 },
  { t: "heavy", from: 5, w: 4 },
  { t: "shield", from: 6, w: 4 },
];
const BOSS_CYCLE: EnemyKind[] = ["boss", "eraser", "inkblot"];
const BOSS_NAMES: Record<string, string> = { boss: "THE DOODLER", eraser: "THE ERASER", inkblot: "THE INKBLOT" };

const MODIFIERS = [
  { name: "", speed: 1, dmg: 1, extra: 0 },
  { name: "CAFFEINATED · they move fast", speed: 1.35, dmg: 0.85, extra: 0 },
  { name: "HEAVY INK · they hit harder", speed: 0.9, dmg: 1.4, extra: 0 },
  { name: "SWARM · more of them, thinner", speed: 1.15, dmg: 0.9, extra: 3 },
];

const TIPS = [
  "hold <b>Q</b>/<b>E</b> to grapple rooftops · tap again to let go",
  "block with the <b>KATANA</b> — some of their bullets go back",
  "kills in the air are worth more · stay off the floor",
  "<b>G</b> lobs a grenade · pickups give you more",
  "press <b>Space</b> again in the air for a double jump",
];

type Bullet = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  dmg: number;
  headMul: number;
  friendly: boolean;
  ink: InkId;
  mesh: THREE.Mesh;
  source: string;
};
type Grenade = { pos: THREE.Vector3; vel: THREE.Vector3; fuse: number; mesh: THREE.Mesh };
type Shard = { mesh: THREE.Mesh; vel: THREE.Vector3; life: number; spin: number };
type Splat = { mesh: THREE.Mesh; life: number };
type Pickup = { kind: "ammo" | "health"; pos: THREE.Vector3; mesh: THREE.Group };

/* ============================== engine ============================== */

export function createGame(container: HTMLElement, cb: EngineCallbacks): GameHandle {
  /* ---------- renderer / scene / paper post ---------- */
  const canvas = document.createElement("canvas");
  canvas.className = "dd-canvas";
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 300);
  scene.add(camera);

  const rt = new THREE.WebGLRenderTarget(4, 4, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
  });
  rt.depthTexture = new THREE.DepthTexture(4, 4);
  rt.depthTexture.type = THREE.UnsignedIntType;

  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postScene = new THREE.Scene();
  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture },
      tDepth: { value: rt.depthTexture },
      uRes: { value: new THREE.Vector2(4, 4) },
      uTime: { value: 0 },
      uHurt: { value: 0 },
      uFlash: { value: 0 },
      uSlow: { value: 0 },
      uLowHp: { value: 0 },
      uOutline: { value: 1 },
      uPaper: { value: new THREE.Color(PAPER) },
      uInks: {
        value: [INK.BLUE, INK.RED, INK.BLACK, INK.ORANGE, INK.GREEN, INK.PINK].map((i) => new THREE.Color(i)),
      },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
    fragmentShader: PAPER_FRAG,
    depthTest: false,
    depthWrite: false,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

  const district: District = buildDistrict(scene);
  const world = { colliders: district.colliders, bounds: district.bounds };
  const fx = new AudioFX();

  /* ---------- input state ---------- */
  const keys = new Set<string>();
  const mouseButtons = new Set<number>();
  let mouseFire = false;
  let mouseAim = false;
  let locked = false;
  let sensitivity = 100; // slider percentage; 100 = default look speed

  /* ---------- player ---------- */
  const player = {
    pos: new THREE.Vector3(0, 0.2, 38),
    vel: new THREE.Vector3(),
    yaw: Math.PI,
    pitch: 0,
    hp: 120,
    maxHp: 120,
    onGround: false,
    jumps: 0,
    crouch: false,
    sprint: false,
    radius: 0.42,
    height: 1.7,
    regenDelay: 0,
    grenades: 3,
    maxGrenades: 5,
    nadeCd: 0,
    dashT: 0,
    dashCd: 0,
    hurtFx: 0,
    flashFx: 0,
    alive: true,
    grap: { active: false, point: new THREE.Vector3(), len: 0, stam: 1 },
  };

  /* ---------- weapon state ---------- */
  const slots = WEAPONS.map((def) => ({ def, mag: def.magSize, reserve: def.reserve }));
  let curSlot = 0;
  let switchT = 0;
  let fireCd = 0;
  let reloadT = 0;
  let recoil = 0;
  let katanaStreak = 0;
  const katanaNeed = 3;
  let slowmoT = 0;
  let focusChain = 0;
  let blocking = false;

  /* ---------- run state ---------- */
  type RunState = "menu" | "playing" | "paused" | "over";
  let state: RunState = "menu";
  let score = 0;
  let kills = 0;
  let wave = 0;
  let comboCount = 0;
  let comboT = 0;
  let hitstopT = 0;
  let shakeT = 0;
  let enemiesLeft = 0;
  let modifierName = "";
  let modSpeed = 1;
  let modDmg = 1;

  const enemies: Enemy[] = [];
  const bullets: Bullet[] = [];
  const grenades: Grenade[] = [];
  const shards: Shard[] = [];
  const splats: Splat[] = [];
  const pickups: Pickup[] = [];

  /* ---------- viewmodel rig ---------- */
  const rig = new THREE.Group();
  camera.add(rig);
  const matGun = makeInkMaterial(INK.BLUE, false);
  const matGunDark = makeInkMaterial(INK.BLACK, true);
  const viewModels: THREE.Group[] = [];
  const gunPart = (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, dark: boolean) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dark ? matGunDark : matGun);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const buildViewModel = (kind: string): THREE.Group => {
    const g = new THREE.Group();
    if (kind === "rifle") {
      gunPart(g, 0.09, 0.12, 0.62, 0, 0, -0.28, false);
      gunPart(g, 0.05, 0.2, 0.1, 0, -0.12, -0.05, true);
      gunPart(g, 0.06, 0.06, 0.18, 0, 0.07, -0.42, true);
    } else if (kind === "shotgun") {
      gunPart(g, 0.12, 0.13, 0.55, 0, 0, -0.26, false);
      gunPart(g, 0.09, 0.09, 0.5, 0, 0.09, -0.32, true);
      gunPart(g, 0.06, 0.18, 0.1, 0, -0.13, -0.02, true);
    } else if (kind === "sniper") {
      gunPart(g, 0.08, 0.11, 0.9, 0, 0, -0.4, false);
      gunPart(g, 0.07, 0.07, 0.26, 0, 0.11, -0.3, true);
      gunPart(g, 0.05, 0.18, 0.09, 0, -0.12, -0.02, true);
    } else if (kind === "revolver") {
      gunPart(g, 0.08, 0.12, 0.3, 0, 0, -0.14, false);
      gunPart(g, 0.09, 0.09, 0.1, 0, -0.02, -0.06, true);
      gunPart(g, 0.05, 0.14, 0.07, 0, -0.11, 0.02, true);
    } else {
      // katana
      gunPart(g, 0.04, 0.05, 0.24, 0, 0, 0.1, true);
      const blade = gunPart(g, 0.025, 0.09, 1.05, 0, 0.02, -0.5, false);
      blade.rotation.x = 0.06;
    }
    g.visible = false;
    rig.add(g);
    viewModels.push(g);
    return g;
  };
  for (const w of WEAPONS) buildViewModel(w.kind);

  const setViewModel = (i: number) => {
    viewModels.forEach((g, j) => (g.visible = j === i));
  };

  /* ---------- pools ---------- */
  const bulletGeo = new THREE.BoxGeometry(0.05, 0.05, 0.6);
  const spawnBullet = (pos: THREE.Vector3, vel: THREE.Vector3, dmg: number, friendly: boolean, ink: InkId, source: string, headMul = 1) => {
    const mesh = new THREE.Mesh(bulletGeo, makeInkMaterial(ink, false, THREE.FrontSide, true));
    mesh.position.copy(pos);
    mesh.lookAt(pos.clone().add(vel));
    scene.add(mesh);
    bullets.push({ pos: pos.clone(), vel: vel.clone(), life: 2.2, dmg, headMul, friendly, ink, mesh, source });
  };

  const shardGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const spawnShards = (pos: THREE.Vector3, ink: InkId, n: number, force: number) => {
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(shardGeo, makeInkMaterial(ink, false, THREE.FrontSide, true));
      mesh.position.copy(pos);
      scene.add(mesh);
      shards.push({
        mesh,
        vel: new THREE.Vector3(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(force * rand(0.5, 1.3)),
        life: rand(0.35, 0.8),
        spin: rand(-8, 8),
      });
    }
  };

  const ropeMat = makeInkMaterial(INK.BLACK, false, THREE.FrontSide, true);
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 1, 5), ropeMat);
  rope.visible = false;
  scene.add(rope);

  const splatGeo = new THREE.CircleGeometry(0.55, 7);
  const spawnSplat = (pos: THREE.Vector3, ink: InkId) => {
    const mesh = new THREE.Mesh(splatGeo, makeInkMaterial(ink, false, THREE.FrontSide, true));
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = rand(0, Math.PI * 2);
    mesh.position.set(pos.x, 0.02 + splats.length * 0.0004, pos.z);
    mesh.scale.setScalar(rand(0.7, 1.4));
    scene.add(mesh);
    splats.push({ mesh, life: 12 });
    if (splats.length > 40) {
      const old = splats.shift()!;
      scene.remove(old.mesh);
    }
  };

  /* ---------- helpers ---------- */
  const eyePos = () => new THREE.Vector3(player.pos.x, player.pos.y + (player.crouch ? JN * 0.94 : 1.6), player.pos.z);
  const fwdVec = () => new THREE.Vector3(-Math.sin(player.yaw) * Math.cos(player.pitch), Math.sin(player.pitch), -Math.cos(player.yaw) * Math.cos(player.pitch));

  function rayAABB(origin: THREE.Vector3, dir: THREE.Vector3, c: Collider, maxDist: number): number {
    let tmin = 0;
    let tmax = maxDist;
    for (const axis of ["x", "y", "z"] as const) {
      const o = origin[axis];
      const d = dir[axis];
      const mn = axis === "x" ? c.minX : axis === "y" ? c.minY : c.minZ;
      const mx = axis === "x" ? c.maxX : axis === "y" ? c.maxY : c.maxZ;
      if (Math.abs(d) < 1e-8) {
        if (o < mn || o > mx) return -1;
      } else {
        let t1 = (mn - o) / d;
        let t2 = (mx - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  }

  function raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, minTopY = 1.2): number {
    let best = maxDist;
    for (const c of world.colliders) {
      if (c.maxY < minTopY) continue;
      const t = rayAABB(origin, dir, c, best);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  function segmentHitsPlayer(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const p = player.pos;
    const c: Collider = { minX: p.x - 0.4, maxX: p.x + 0.4, minY: p.y, maxY: p.y + player.height, minZ: p.z - 0.4, maxZ: p.z + 0.4 };
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-6) return false;
    dir.divideScalar(len);
    const t = rayAABB(from, dir, c, len);
    return t >= 0;
  }

  /* ---------- shooting ---------- */
  function fireWeapon() {
    const s = slots[curSlot];
    const def = s.def;
    if (reloadT > 0 || switchT > 0) return;
    if (def.katana) {
      katanaSlash();
      fireCd = def.interval;
      return;
    }
    if (s.mag <= 0) {
      fx.dry();
      startReload();
      return;
    }
    s.mag--;
    fireCd = def.interval;
    recoil = Math.min(recoil + (def.kind === "shotgun" ? 3.2 : 1.2), 5);
    player.pitch += def.kind === "sniper" ? 0.02 : 0.006;
    player.flashFx = 0.14;
    if (def.kind === "shotgun") fx.shotgun();
    else if (def.kind === "sniper") fx.sniper();
    else fx.shoot();

    const eye = eyePos();
    const base = fwdVec();
    const spread = (mouseAim ? def.adsSpread : def.spread) * (player.onGround ? 1 : 1.8);
    for (let i = 0; i < def.pellets; i++) {
      const dir = base.clone();
      dir.x += rand(-spread, spread);
      dir.y += rand(-spread, spread);
      dir.z += rand(-spread, spread);
      dir.normalize();
      const hitT = raycastWorld(eye, dir, 160);
      // friendly tracer
      const hitPoint = eye.clone().addScaledVector(dir, hitT);
      spawnBullet(eye.clone().addScaledVector(dir, 0.6), dir.multiplyScalar(70), def.damage, true, INK.BLUE, def.kind, def.headMul);
      if (hitT < 160) spawnShards(hitPoint, INK.BLACK, 2, 2);
    }
    pushHud();
  }

  function startReload() {
    const s = slots[curSlot];
    if (s.def.katana || reloadT > 0 || s.mag >= s.def.magSize || s.reserve <= 0) return;
    reloadT = s.def.reloadTime;
    fx.reload();
  }

  function finishReload() {
    const s = slots[curSlot];
    const need = s.def.magSize - s.mag;
    const take = Math.min(need, s.reserve);
    s.mag += take;
    s.reserve -= take;
    pushHud();
  }

  function switchSlot(i: number) {
    if (i === curSlot || i < 0 || i >= slots.length) return;
    curSlot = i;
    switchT = 0.28;
    reloadT = 0;
    setViewModel(i);
    fx.uiClick();
    pushHud();
  }

  function katanaSlash() {
    fx.katana();
    recoil = 2.5;
    const eye = eyePos();
    const fwd = fwdVec();
    let hitAny = false;
    for (const e of enemies) {
      if (!e.alive) continue;
      const to = e.pos.clone().add(new THREE.Vector3(0, 1.2 * e.def.scale, 0)).sub(eye);
      const dist = to.length();
      if (dist > 2.8 * e.def.scale) continue;
      to.normalize();
      if (to.dot(fwd) < 0.35) continue;
      hitAny = true;
      const headHit = to.dot(fwd) > 0.85;
      damageEnemy(e, headHit ? 999 : 90 * (1 + wave * 0.03), headHit, "katana", to);
    }
    if (!hitAny) katanaStreak = 0;
    pushHud();
  }

  function tryFocusDash() {
    if (slowmoT <= 0 || focusChain >= 2) return;
    const eye = eyePos();
    const fwd = fwdVec();
    let target: Enemy | null = null;
    let bestD = 14;
    for (const e of enemies) {
      if (!e.alive) continue;
      const to = e.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(eye);
      const d = to.length();
      if (d < bestD && to.normalize().dot(fwd) > 0.4) {
        target = e;
        bestD = d;
      }
    }
    if (!target) return;
    focusChain++;
    slowmoT = 0;
    const dest = target.pos.clone().sub(new THREE.Vector3(0, 0, 0));
    const dir = dest.clone().sub(player.pos).normalize();
    player.pos.copy(dest.clone().addScaledVector(dir, -1.4));
    player.yaw = Math.atan2(-dir.x, -dir.z);
    fx.focusDash();
    shakeT = 0.2;
    damageEnemy(target, 9999, false, "focus", dir);
    cb.onTip("<b>EXECUTED</b>", 1.2);
  }

  /* ---------- damage ---------- */
  function damageEnemy(e: Enemy, amount: number, crit: boolean, source: string, dir?: THREE.Vector3) {
    if (!e.alive) return;
    if (e.def.shield && e.shieldMesh && source !== "katana" && source !== "blast" && source !== "focus") {
      const toPlayer = player.pos.clone().sub(e.pos).normalize();
      const facing = new THREE.Vector3(Math.sin(e.root.rotation.y), 0, Math.cos(e.root.rotation.y));
      if (facing.dot(toPlayer) > 0.2) {
        spawnShards(e.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), INK.ORANGE, 4, 3);
        fx.hitEnemy();
        cb.onHitmarker(false, false);
        return;
      }
    }
    e.hp -= amount;
    e.t += 0.05;
    spawnShards(e.pos.clone().add(new THREE.Vector3(0, 1.2 * e.def.scale, 0)), crit ? INK.RED : e.def.ink, crit ? 7 : 3, 2.4);
    if (e.hp <= 0) killEnemy(e, source, crit, dir);
    else {
      fx.hitEnemy();
      cb.onHitmarker(false, crit);
    }
    pushHud();
  }

  function killEnemy(e: Enemy, source: string, crit: boolean, _dir?: THREE.Vector3) {
    e.alive = false;
    e.dying = 0.6;
    const credit = source !== "enemy" && source !== "self";
    if (credit) kills++;
    enemiesLeft = Math.max(0, enemiesLeft - 1);
    let pts = e.def.score;
    let label = `ERASED ${e.def.name}`;
    if (crit) label += " · headshot";
    if (source === "focus") {
      label = "EXECUTED " + e.def.name;
      pts += 150;
    }
    if (source === "deflect") {
      label = "RETURN TO SENDER · " + e.def.name;
      pts += 120;
    }
    if (source === "blast") label = "BLOWN AWAY · " + e.def.name;
    if (!player.onGround && credit) pts = Math.round(pts * 1.3);
    if (credit) addScore(pts, label);
    comboCount++;
    comboT = 2.4;
    fx.kill();
    if (crit) fx.headshot();
    cb.onHitmarker(true, crit);
    spawnSplat(e.pos, e.def.ink);
    spawnShards(e.pos.clone().add(new THREE.Vector3(0, 1, 0)), e.def.ink, e.def.boss ? 22 : 12, 4);

    if (credit && (source === "katana" || source === "focus")) {
      katanaStreak++;
      if (katanaStreak >= katanaNeed && slowmoT <= 0 && focusChain < 2) {
        slowmoT = 2.6;
        katanaStreak = 0;
        fx.focusIn();
        cb.onTip("<b>SLASH READY</b> · press F near an enemy", 2.2);
      }
    } else if (source !== "deflect" && source !== "blast") {
      katanaStreak = 0;
    }
    if (e.def.boss) {
      cb.onBoss(null, 0);
      cb.onKillFeed(`${e.def.name} ERASED`, true);
      shakeT = 0.5;
    }
    pushHud();
  }

  function damagePlayer(amount: number, fromDir?: THREE.Vector3) {
    if (!player.alive || state !== "playing") return;
    player.hp -= amount;
    player.regenDelay = 4.5;
    player.hurtFx = Math.min(1, player.hurtFx + 0.5);
    shakeT = Math.max(shakeT, 0.25);
    fx.hurt();
    if (fromDir) {
      // nudge
      player.vel.addScaledVector(fromDir, 1.4);
    }
    if (player.hp <= 0) {
      player.hp = 0;
      player.alive = false;
      gameOver();
    }
    pushHud();
  }

  function addScore(n: number, feed?: string) {
    score += n;
    if (feed) cb.onKillFeed(feed, n >= 1000);
  }

  /* ---------- enemies ---------- */
  function makeLocalRig(def: EnemyDef) {
    let rigB: Rig;
    if (def.model === "flyer") rigB = makeWaspRig({ ink: def.ink, bodyW: 1, headS: 1, limbR: 0.03, scale: def.scale });
    else if (def.model === "blob") rigB = makeBlobRig({ ink: def.ink, bodyW: 1, headS: 1, limbR: 0.03, scale: def.scale, weapon: def.weapon }, def.bossKind);
    else rigB = makeRig({ ink: def.ink, bodyW: (def as EnemyDefX).bodyW ?? 1, headS: (def as EnemyDefX).headS ?? 1, limbR: (def as EnemyDefX).limbR ?? 0.032, hat: def.hat, shield: def.shield, weapon: def.weapon, scale: def.scale, smile: def.weapon === "blade" });
    const P = rigB.parts;
    return {
      root: rigB.root,
      head: P.head,
      torso: P.torso,
      legL: P.legL,
      legR: P.legR,
      armL: P.armL,
      armR: P.armR,
      hatMesh: null,
      shieldMesh: P.shield,
      headY: rigB.headWorldY,
    };
  }
  function spawnEnemy(kind: EnemyKind) {
    const def = ED[kind];
    const built = makeLocalRig(def);
    let pos: THREE.Vector3;
    if (def.flying) {
      const a = rand(0, Math.PI * 2);
      const r = rand(20, 34);
      pos = new THREE.Vector3(clamp(player.pos.x + Math.cos(a) * r, world.bounds.minX, world.bounds.maxX), rand(4, 9), clamp(player.pos.z + Math.sin(a) * r, world.bounds.minZ, world.bounds.maxZ));
    } else {
      let best = district.spawnPoints[0];
      let bestD = -1;
      for (let i = 0; i < 6; i++) {
        const sp = pick(district.spawnPoints);
        const d = sp.distanceTo(player.pos);
        if (d > bestD) {
          bestD = d;
          best = sp;
        }
      }
      pos = best.clone();
      pos.y = 0.2;
    }
    const e: Enemy = {
      kind,
      def,
      root: built.root,
      head: built.head,
      torso: built.torso,
      legL: built.legL,
      legR: built.legR,
      armL: built.armL,
      armR: built.armR,
      hatMesh: built.hatMesh,
      shieldMesh: built.shieldMesh,
      headY: built.headY,
      pos,
      vel: new THREE.Vector3(),
      hp: def.hp * (1 + Math.max(0, wave - 1) * 0.06),
      maxHp: def.hp * (1 + Math.max(0, wave - 1) * 0.06),
      alive: true,
      onGround: false,
      cooldown: rand(1, def.cool[1]),
      t: rand(0, 10),
      strafe: Math.random() < 0.5 ? 1 : -1,
      dying: 0,
    };
    built.root.position.copy(pos);
    built.root.rotation.y = rand(0, Math.PI * 2);
    scene.add(built.root);
    enemies.push(e);
    if (def.boss) cb.onBoss(def.name, 1);
    spawnShards(pos.clone().add(new THREE.Vector3(0, 1, 0)), def.ink, 8, 3);
  }

  function enemyAttack(e: Enemy) {
    const eye = e.pos.clone().add(new THREE.Vector3(0, 1.6 * e.def.scale, 0));
    const target = eyePos();
    const dir = target.clone().sub(eye);
    const dist = dir.length();
    dir.normalize();
    const w = e.def.weapon;
    const speed = w === "sniper" ? 90 : w === "rifle" ? 55 : 45;
    const dmg = e.def.dmg * modDmg;
    const err = w === "sniper" ? 0.008 : 0.05;
    if (w === "shotgun") {
      for (let i = 0; i < 7; i++) {
        const d2 = dir.clone();
        d2.x += rand(-0.09, 0.09);
        d2.y += rand(-0.09, 0.09);
        d2.z += rand(-0.09, 0.09);
        spawnBullet(eye, d2.normalize().multiplyScalar(40), dmg, false, INK.RED, "enemy");
      }
    } else if (w === "rifle" || w === "pistol" || w === "boss") {
      const n = w === "rifle" ? 3 : w === "boss" ? 5 : 2;
      for (let i = 0; i < n; i++) {
        const d2 = dir.clone();
        d2.x += rand(-err, err) * 3;
        d2.y += rand(-err, err) * 3;
        d2.z += rand(-err, err) * 3;
        spawnBullet(eye, d2.normalize().multiplyScalar(speed), dmg, false, INK.RED, "enemy");
      }
    } else if (w === "sniper") {
      spawnBullet(eye, dir.clone().multiplyScalar(speed), dmg, false, INK.GREEN, "enemy");
    } else if (w === "blade") {
      if (dist < 3) damagePlayer(dmg, dir);
      e.armR.rotation.x = -2.4;
    } else if (w === "dive") {
      if (dist < 2.2) {
        damagePlayer(dmg, dir);
        e.vel.addScaledVector(dir, -12);
        e.cooldown = rand(1.5, 2.5);
      }
    }
    fx.enemyShot();
  }

  function explode(pos: THREE.Vector3, radius: number, dmg: number, fromPlayer: boolean) {
    fx.explosion();
    shakeT = Math.max(shakeT, 0.35);
    spawnShards(pos, INK.BLACK, 18, 7);
    spawnShards(pos, INK.ORANGE, 10, 5);
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(pos);
      if (d < radius) {
        const f = 1 - d / radius;
        damageEnemy(e, dmg * f, false, fromPlayer ? "blast" : "enemy");
      }
    }
    const pd = player.pos.distanceTo(pos);
    if (pd < radius * 0.8) {
      damagePlayer(dmg * 0.5 * (1 - pd / (radius * 0.8)));
    }
  }

  function updateEnemy(e: Enemy, dt: number) {
    e.t += dt;
    if (!e.alive) {
      e.dying -= dt;
      e.torso.rotation.x = Math.min(1.5, e.torso.rotation.x + dt * 6);
      e.root.position.y -= dt * 1.2;
      if (e.dying <= 0) {
        scene.remove(e.root);
      }
      return;
    }
    const toPlayer = player.pos.clone().sub(e.pos);
    const dist = toPlayer.length();
    const dirXZ = new THREE.Vector3(toPlayer.x, 0, toPlayer.z);
    const flatDist = dirXZ.length();
    dirXZ.normalize();
    e.root.rotation.y = Math.atan2(dirXZ.x, dirXZ.z);

    // separation
    for (const o of enemies) {
      if (o === e || !o.alive) continue;
      const d2 = o.pos.distanceTo(e.pos);
      if (d2 < 1.6 && d2 > 0.001) {
        const push = e.pos.clone().sub(o.pos).setY(0).normalize().multiplyScalar((1.6 - d2) * 2.2 * dt);
        e.pos.add(push);
      }
    }

    const speed = e.def.speed * modSpeed;
    const stop = e.def.stop;
    if (e.def.flying) {
      const hover = 2.6 + Math.sin(e.t * 3) * 0.7;
      const move = dirXZ.clone().multiplyScalar(speed * dt * (flatDist > 4 ? 1 : -0.4));
      e.pos.add(move);
      e.pos.y += (hover - e.pos.y) * Math.min(1, dt * 2);
      if (e.kind === "flyer" && flatDist < 10) {
        // dive
        const diveDir = player.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(e.pos).normalize();
        e.pos.addScaledVector(diveDir, speed * dt * 1.4);
      }
    } else {
      if (flatDist > stop + 1) {
        e.vel.x = dirXZ.x * speed;
        e.vel.z = dirXZ.z * speed;
      } else {
        e.vel.x *= 0.8;
        e.vel.z *= 0.8;
        // strafe
        const side = new THREE.Vector3(-dirXZ.z, 0, dirXZ.x).multiplyScalar(e.strafe * speed * 0.4);
        e.vel.x = side.x;
        e.vel.z = side.z;
        if (Math.random() < dt * 0.5) e.strafe *= -1;
      }
      e.vel.y -= 22 * dt;
      const r = resolveMove(e.pos, e.vel, 0.45 * e.def.scale, 1.85 * e.def.scale, world.colliders, dt);
      e.onGround = r.onGround;
    }
    e.pos.x = clamp(e.pos.x, world.bounds.minX, world.bounds.maxX);
    e.pos.z = clamp(e.pos.z, world.bounds.minZ, world.bounds.maxZ);
    e.root.position.copy(e.pos);

    // limbs
    const moving = Math.abs(e.vel.x) + Math.abs(e.vel.z) > 0.4;
    const sw = moving ? Math.sin(e.t * 10) * 0.5 : 0;
    e.legL.rotation.x = sw;
    e.legR.rotation.x = -sw;
    e.armL.rotation.x = -sw * 0.6;
    if (e.armR.rotation.x < -0.1) e.armR.rotation.x += dt * 6;
    else e.armR.rotation.x = sw * 0.6;

    // attack
    e.cooldown -= dt;
    if (e.cooldown <= 0 && dist < e.def.range) {
      if (e.def.weapon === "bomb") {
        // explode on contact
        explode(e.pos.clone().add(new THREE.Vector3(0, 0.8, 0)), 4.2, e.def.dmg, false);
        killEnemy(e, "self", false);
        return;
      }
      enemyAttack(e);
      e.cooldown = rand(e.def.cool[0], e.def.cool[1]);
      if (e.def.weapon === "boss") {
        // summon adds
        const aliveCount = enemies.filter((x) => x.alive).length;
        if (aliveCount < 10 && Math.random() < 0.3) {
          spawnEnemy("grunt");
          spawnEnemy("grunt");
        }
      }
    }
  }

  /* ---------- waves ---------- */
  let queue: EnemyKind[] = [];
  let spawnT = 0;
  let maxAlive = 6;
  let intermissionT = 0;

  function startWave(n: number) {
    wave = n;
    queue = [];
    spawnT = 2;
    const isBoss = n > 0 && n % 5 === 0;
    const modPool = isBoss || n < 4 ? 1 : n < 6 ? 3 : MODIFIERS.length;
    const mod = MODIFIERS[Math.floor(Math.random() * modPool)];
    modSpeed = mod.speed;
    modDmg = mod.dmg * (1 + (n - 1) * 0.03);
    modifierName = mod.name;
    const swarm = mod.name.startsWith("SWARM");
    maxAlive = Math.min(4 + Math.floor(n * 0.9) + mod.extra, (swarm ? 22 : 18) + Math.floor(n / 3));

    let count = Math.round(Math.min(5 + n * 2, 32 + n) * (swarm ? 1.35 : 1));
    if (isBoss) {
      const bossKind = BOSS_CYCLE[(Math.floor(n / 5) - 1) % BOSS_CYCLE.length];
      queue.push(bossKind);
      count = 7 + n;
      maxAlive += 2 + Math.floor(n / 5);
      cb.onMessage(`WAVE ${n}`, `${BOSS_NAMES[bossKind]} IS COMING`, 3);
      fx.bossRoar();
    } else {
      const subs = ["they are crawling off the page", "ink harder", "keep scribbling", "stay off the ground", "swing for it", "return their bullets"];
      cb.onMessage(`WAVE ${n}`, n === 1 ? subs[0] : modifierName || pick(subs), 2.6);
    }
    const avail = SPAWN_TABLE.filter((r) => n >= r.from);
    const totalW = avail.reduce((a, c) => a + c.w, 0);
    for (let i = 0; i < count; i++) {
      let c = Math.random() * totalW;
      let t = avail[0].t;
      for (const r of avail) {
        c -= r.w;
        if (c <= 0) {
          t = r.t;
          break;
        }
      }
      queue.push(t);
    }
    enemiesLeft = queue.length;
    fx.wave();
    if (n <= TIPS.length) cb.onTip(TIPS[n - 1], 7);
    player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
    spawnPickups();
    pushHud();
  }

  function spawnPickups() {
    for (let i = 0; i < 7; i++) {
      const kind: "ammo" | "health" = i < 5 ? "ammo" : "health";
      const a = rand(0, Math.PI * 2);
      const r = rand(8, 40);
      const pos = new THREE.Vector3(clamp(Math.cos(a) * r, world.bounds.minX, world.bounds.maxX), 0.6, clamp(Math.sin(a) * r, world.bounds.minZ, world.bounds.maxZ));
      const g = new THREE.Group();
      const ink: InkId = kind === "ammo" ? INK.BLUE : INK.GREEN;
      const m = makeInkMaterial(ink, true);
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), m);
      g.add(box);
      if (kind === "health") {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.14), m);
        bar.rotation.z = Math.PI / 4;
        g.add(bar);
      }
      g.position.copy(pos);
      scene.add(g);
      pickups.push({ kind, pos, mesh: g });
    }
  }

  /* ---------- grapple ---------- */
  function grappleToggle() {
    if (player.grap.active) {
      player.grap.active = false;
      return;
    }
    const eye = eyePos();
    const dir = fwdVec();
    const t = raycastWorld(eye, dir, 34);
    if (t < 34) {
      player.grap.active = true;
      player.grap.point.copy(eye).addScaledVector(dir, t);
      player.grap.len = t;
      fx.grappleFire();
      setTimeout(() => fx.grappleHit(), 90);
    }
  }

  function updateGrapple(dt: number) {
    const g = player.grap;
    if (!g.active) {
      g.stam = Math.min(1, g.stam + dt * 0.5);
      rope.visible = false;
      return;
    }
    rope.visible = true;
    const eye = eyePos();
    const mid = eye.clone().add(g.point).multiplyScalar(0.5);
    rope.position.copy(mid);
    const d = g.point.clone().sub(eye);
    rope.scale.set(1, d.length(), 1);
    rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const toAnchor = g.point.clone().sub(player.pos);
    const dist = toAnchor.length();
    const dir = toAnchor.normalize();
    // reel in while held
    const reeling = keys.has("KeyQ") || keys.has("KeyE") || mouseButtons.has(1);
    if (reeling && g.stam > 0) {
      g.len = Math.max(2, g.len - dt * 9);
      g.stam = Math.max(0, g.stam - dt * 0.55);
    }
    if (dist > g.len) {
      player.pos.addScaledVector(dir, (dist - g.len) * Math.min(1, dt * 10));
      const along = player.vel.dot(dir);
      if (along < 0) player.vel.addScaledVector(dir, -along);
    }
    player.vel.addScaledVector(dir, dt * 6);
    if (g.stam <= 0) g.active = false;
  }

  /* ---------- grenades ---------- */
  function throwGrenade() {
    if (player.grenades <= 0 || player.nadeCd > 0) return;
    player.grenades--;
    player.nadeCd = 0.6;
    const eye = eyePos();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), makeInkMaterial(INK.BLACK, true));
    mesh.position.copy(eye);
    scene.add(mesh);
    grenades.push({
      pos: eye.clone(),
      vel: fwdVec().multiplyScalar(15).add(new THREE.Vector3(0, 4, 0)),
      fuse: 1.6,
      mesh,
    });
    pushHud();
  }

  /* ---------- pickups ---------- */
  function updatePickups(dt: number) {
    for (let i = pickups.length - 1; i >= 0; i--) {
      const p = pickups[i];
      p.mesh.rotation.y += dt * 2;
      p.mesh.position.y = p.pos.y + Math.sin(performance.now() * 0.003 + i) * 0.12;
      if (p.mesh.position.distanceTo(player.pos) < 1.7) {
        if (p.kind === "ammo") {
          for (const s of slots) {
            if (isFinite(s.def.maxReserve)) s.reserve = Math.min(s.def.maxReserve, s.reserve + s.def.maxReserve * 0.4);
          }
          player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
          cb.onKillFeed("+AMMO · +GRENADE", false);
        } else {
          player.hp = Math.min(player.maxHp, player.hp + 35);
          cb.onKillFeed("+HEALTH", false);
        }
        fx.pickup();
        scene.remove(p.mesh);
        pickups.splice(i, 1);
        pushHud();
      }
    }
  }

  /* ---------- player update ---------- */
  function updatePlayer(dt: number) {
    const p = player;
    p.crouch = keys.has("ControlLeft") || keys.has("KeyC");
    p.sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");
    p.height = p.crouch ? JN : CI;

    let ix = 0;
    let iz = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) iz -= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) iz += 1;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) ix -= 1;
    if (keys.has("KeyD") || keys.has("ArrowRight")) ix += 1;
    const move = new THREE.Vector3(ix, 0, iz);
    if (move.lengthSq() > 0) move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);

    let speed = p.crouch ? VR : p.sprint && iz < 0 ? QR : PR;
    if (mouseAim) speed *= 0.8;
    if (p.dashT > 0) {
      speed *= 3.4;
      p.dashT -= dt;
    }
    p.dashCd = Math.max(0, p.dashCd - dt);

    const accel = p.onGround ? 40 : 12;
    p.vel.x += (move.x * speed - p.vel.x) * Math.min(1, accel * dt);
    p.vel.z += (move.z * speed - p.vel.z) * Math.min(1, accel * dt);
    p.vel.y -= 22 * dt;

    updateGrapple(dt);

    const wasGround = p.onGround;
    const r = resolveMove(p.pos, p.vel, p.radius, p.height, world.colliders, dt);
    p.onGround = r.onGround;
    if (p.onGround) {
      p.jumps = 0;
      if (!wasGround) recoil = Math.max(recoil, 1.2);
    }
    p.pos.x = clamp(p.pos.x, world.bounds.minX, world.bounds.maxX);
    p.pos.z = clamp(p.pos.z, world.bounds.minZ, world.bounds.maxZ);

    // regen
    p.regenDelay = Math.max(0, p.regenDelay - dt);
    if (p.regenDelay <= 0 && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 11 * dt);
    p.hurtFx = Math.max(0, p.hurtFx - dt * 1.4);
    p.flashFx = Math.max(0, p.flashFx - dt * 1.2);
    p.nadeCd = Math.max(0, p.nadeCd - dt);

    // weapons
    fireCd = Math.max(0, fireCd - dt);
    switchT = Math.max(0, switchT - dt);
    if (reloadT > 0) {
      reloadT -= dt;
      if (reloadT <= 0) finishReload();
    }
    if (mouseFire && fireCd <= 0 && state === "playing") {
      fireWeapon();
      if (!slots[curSlot].def.auto) mouseFire = false;
    }
    recoil = Math.max(0, recoil - dt * 14);
    blocking = mouseAim && slots[curSlot].def.katana === true;

    // camera
    const bobT = performance.now() * 0.011;
    const moving = move.lengthSq() > 0 && p.onGround;
    const bobY = moving ? Math.sin(bobT) * 0.035 : 0;
    const bobX = moving ? Math.cos(bobT * 0.5) * 0.02 : 0;
    camera.position.set(p.pos.x + bobX, p.pos.y + (p.crouch ? JN * 0.94 : 1.6) + bobY, p.pos.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = p.yaw;
    camera.rotation.x = p.pitch;
    let roll = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      roll += rand(-1, 1) * 0.02 * shakeT * 4;
      camera.position.y += rand(-1, 1) * 0.05 * shakeT * 4;
    }
    camera.rotation.z = roll;

    // fov / ads
    const def = slots[curSlot].def;
    const targetFov = mouseAim ? def.zoom : BASE_FOV;
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 12);
    camera.updateProjectionMatrix();

    // viewmodel pose
    const vm = viewModels[curSlot];
    if (vm) {
      const ads = mouseAim ? 1 : 0;
      const aimX = def.katana ? 0.27 : 0.22 * (1 - ads * 0.9);
      const aimY = -0.2 + ads * 0.03 - (reloadT > 0 ? 0.14 : 0) - switchT * 0.6;
      const aimZ = -0.42 + ads * 0.12;
      vm.position.set(aimX + bobX * 0.5, aimY + bobY * 0.5, aimZ + recoil * 0.02);
      vm.rotation.set(recoil * 0.04 + (reloadT > 0 ? 0.7 : 0), 0, 0);
    }
  }

  /* ---------- bullets / grenades / shards ---------- */
  function updateBullets(dt: number) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.life -= dt;
      const from = b.pos.clone();
      const step = b.vel.clone().multiplyScalar(dt);
      const to = from.clone().add(step);
      let dead = b.life <= 0;

      // world
      const dir = step.clone();
      const len = dir.length();
      if (len > 1e-6) {
        dir.divideScalar(len);
        const t = rayAABBall(from, dir, len);
        if (t >= 0) {
          dead = true;
          spawnShards(from.clone().addScaledVector(dir, t), b.ink, 2, 1.6);
        }
      }

      // actors
      if (!dead) {
        if (b.friendly) {
          for (const e of enemies) {
            if (!e.alive) continue;
            if (hitEnemySegment(from, to, e, b)) {
              dead = true;
              break;
            }
          }
        } else if (segmentHitsPlayer(from, to)) {
          dead = true;
          if (blocking && blockDeflect(b)) {
            dead = false; // bullet reversed; keep flying
          } else {
            damagePlayer(b.dmg, b.vel.clone().normalize().multiplyScalar(0.6));
          }
        }
      }

      if (dead) {
        scene.remove(b.mesh);
        bullets.splice(i, 1);
      } else {
        b.pos.copy(to);
        b.mesh.position.copy(to);
      }
    }
  }

  function rayAABBall(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    let best = maxDist;
    for (const c of world.colliders) {
      const t = rayAABB(origin, dir, c, best);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  function hitEnemySegment(from: THREE.Vector3, to: THREE.Vector3, e: Enemy, b: Bullet): boolean {
    const s = e.def.scale;
    // head sphere
    const headC = e.pos.clone().add(new THREE.Vector3(0, e.headY, 0));
    const seg = to.clone().sub(from);
    const segLen = seg.length();
    const segDir = seg.clone().divideScalar(segLen);
    const toH = headC.clone().sub(from);
    const proj = toH.dot(segDir);
    if (proj >= 0 && proj <= segLen) {
      const closest = from.clone().addScaledVector(segDir, proj);
      if (closest.distanceTo(headC) < 0.34 * s) {
        damageEnemy(e, b.dmg * b.headMul, true, b.source, segDir);
        return true;
      }
    }
    // body AABB
    const c: Collider = { minX: e.pos.x - 0.5 * s, maxX: e.pos.x + 0.5 * s, minY: e.pos.y, maxY: e.pos.y + 1.85 * s, minZ: e.pos.z - 0.35 * s, maxZ: e.pos.z + 0.35 * s };
    const t = rayAABB(from, segDir, c, segLen);
    if (t >= 0) {
      damageEnemy(e, b.dmg, false, b.source, segDir);
      return true;
    }
    return false;
  }

  function blockDeflect(b: Bullet): boolean {
    const fwd = fwdVec();
    const toB = b.pos.clone().sub(eyePos()).normalize();
    if (fwd.dot(toB) < 0.5) return false;
    // reflect toward nearest enemy
    let target: Enemy | null = null;
    let bestD = 40;
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(player.pos);
      if (d < bestD) {
        bestD = d;
        target = e;
      }
    }
    const dir = target
      ? target.pos.clone().add(new THREE.Vector3(0, 1.2, 0)).sub(b.pos).normalize()
      : b.vel.clone().normalize().negate();
    b.vel.copy(dir.multiplyScalar(60));
    b.friendly = true;
    b.dmg *= 2;
    b.source = "deflect";
    spawnShards(b.pos, INK.ORANGE, 5, 3);
    fx.katana();
    cb.onKillFeed("DEFLECTED", false);
    return true;
  }

  function updateGrenades(dt: number) {
    for (let i = grenades.length - 1; i >= 0; i--) {
      const g = grenades[i];
      g.fuse -= dt;
      g.vel.y -= 20 * dt;
      g.pos.addScaledVector(g.vel, dt);
      if (g.pos.y < 0.12) {
        g.pos.y = 0.12;
        g.vel.y = Math.abs(g.vel.y) * 0.4;
        g.vel.x *= 0.7;
        g.vel.z *= 0.7;
      }
      g.pos.x = clamp(g.pos.x, world.bounds.minX, world.bounds.maxX);
      g.pos.z = clamp(g.pos.z, world.bounds.minZ, world.bounds.maxZ);
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x += dt * 9;
      g.mesh.rotation.y += dt * 7;
      if (g.fuse <= 0) {
        explode(g.pos.clone(), 4.2, 120, true);
        scene.remove(g.mesh);
        grenades.splice(i, 1);
      }
    }
  }

  function updateShards(dt: number) {
    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.life -= dt;
      s.vel.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin * dt;
      s.mesh.rotation.y += s.spin * dt;
      const sc = Math.max(0.01, s.life);
      s.mesh.scale.setScalar(Math.min(1, sc * 2));
      if (s.life <= 0) {
        scene.remove(s.mesh);
        shards.splice(i, 1);
      }
    }
    for (let i = splats.length - 1; i >= 0; i--) {
      const sp = splats[i];
      sp.life -= dt;
      if (sp.life <= 0) {
        scene.remove(sp.mesh);
        splats.splice(i, 1);
      }
    }
  }

  /* ---------- HUD ---------- */
  let hudT = 0;
  function pushHud() {
    const s = slots[curSlot];
    const hud: HudState = {
      score,
      combo: comboCount > 1 ? `combo x${comboCount}` : "",
      wave,
      left: enemiesLeft,
      modifier: modifierName,
      hp: Math.ceil(player.hp),
      maxHp: player.maxHp,
      mag: s.def.katana ? -1 : s.mag,
      reserve: s.def.katana ? -1 : s.reserve,
      reloading: reloadT > 0,
      nades: player.grenades,
      weapon: s.def.name,
      hint: s.def.hint,
      slots: WEAPONS.map((w) => w.name),
      slot: curSlot,
      focus: clamp(katanaStreak / katanaNeed, 0, 1),
      focusOn: slowmoT > 0,
    };
    cb.onHud(hud);
  }

  /* ---------- state transitions ---------- */
  function resetRun() {
    for (const e of enemies) scene.remove(e.root);
    enemies.length = 0;
    for (const b of bullets) scene.remove(b.mesh);
    bullets.length = 0;
    for (const g of grenades) scene.remove(g.mesh);
    grenades.length = 0;
    for (const s of shards) scene.remove(s.mesh);
    shards.length = 0;
    for (const sp of splats) scene.remove(sp.mesh);
    splats.length = 0;
    for (const p of pickups) scene.remove(p.mesh);
    pickups.length = 0;
    for (const s of slots) {
      s.mag = s.def.magSize;
      s.reserve = s.def.reserve;
    }
    player.pos.set(0, 0.2, 38);
    player.vel.set(0, 0, 0);
    player.yaw = Math.PI;
    player.pitch = 0;
    player.hp = player.maxHp;
    player.alive = true;
    player.grenades = 3;
    player.grap.active = false;
    player.grap.stam = 1;
    curSlot = 0;
    setViewModel(0);
    score = 0;
    kills = 0;
    wave = 0;
    comboCount = 0;
    katanaStreak = 0;
    slowmoT = 0;
    focusChain = 0;
    modifierName = "";
    queue = [];
    enemiesLeft = 0;
    reloadT = 0;
    fireCd = 0;
    intermissionT = 3;
    // Re-sync the React HUD (it is only pushed from the game loop while
    // playing, so without this the menu overlay — which renders when
    // hud.wave === 0 — never appears after leaving a run).
    pushHud();
  }

  function gameOver() {
    state = "over";
    document.exitPointerLock?.();
    const bestKey = "dd_best";
    const prev = Number(localStorage.getItem(bestKey) || 0);
    const isBest = score > prev;
    if (isBest) localStorage.setItem(bestKey, String(score));
    const prevWave = Number(localStorage.getItem("dd_best_wave") || 0);
    if (wave > prevWave) localStorage.setItem("dd_best_wave", String(wave));
    fx.wave();
    cb.onBoss(null, 0);
    cb.onGameOver({ wave, kills, score, best: isBest });
  }

  function step(dtRaw: number) {
    const t = performance.now() * 0.001;
    postMat.uniforms.uTime.value = t;

    if (state !== "playing") {
      // idle sway for menu backdrop
      camera.position.set(player.pos.x, player.pos.y + 1.62, player.pos.z);
      camera.rotation.order = "YXZ";
      camera.rotation.y = player.yaw + Math.sin(t * 0.3) * 0.05;
      camera.rotation.x = player.pitch + Math.sin(t * 0.23) * 0.03;
      camera.rotation.z = 0;
      renderFrame();
      return;
    }

    hitstopT = Math.max(0, hitstopT - dtRaw);
    let dt = dtRaw;
    if (slowmoT > 0) {
      slowmoT -= dtRaw;
      dt = dtRaw * 0.32;
      if (slowmoT <= 0) focusChain = 0;
    }
    if (hitstopT > 0) dt *= 0.2;

    updatePlayer(dtRaw);
    for (const e of enemies) updateEnemy(e, dt);
    // cull fully-dead
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (!enemies[i].alive && enemies[i].dying <= -0.1) enemies.splice(i, 1);
    }
    updateBullets(dt);
    updateGrenades(dt);
    updateShards(dtRaw);
    updatePickups(dt);

    // wave spawner
    if (queue.length > 0) {
      spawnT -= dt;
      const alive = enemies.filter((e) => e.alive).length;
      if (spawnT <= 0 && alive < maxAlive) {
        spawnEnemy(queue.shift()!);
        spawnT = 0.55;
        enemiesLeft = queue.length + alive;
        pushHud();
      }
    } else {
      const alive = enemies.filter((e) => e.alive).length;
      enemiesLeft = alive;
      if (alive === 0) {
        intermissionT -= dtRaw;
        if (intermissionT <= 0) {
          intermissionT = 3;
          if (wave % 5 === 0 && wave > 0) cb.onKillFeed(`CHECKPOINT · WAVE ${wave}`, false);
          cb.onMessage("WAVE CLEARED", `score ${score} · next wave incoming…`, 2.4);
          startWave(wave + 1);
        }
      }
    }

    comboT -= dtRaw;
    if (comboT <= 0) comboCount = 0;

    postMat.uniforms.uHurt.value = player.hurtFx;
    postMat.uniforms.uFlash.value = player.flashFx;
    postMat.uniforms.uLowHp.value = player.hp < player.maxHp * 0.3 && player.alive ? 1 : 0;
    const slowU = postMat.uniforms.uSlow.value as number;
    postMat.uniforms.uSlow.value = slowU + ((slowmoT > 0 ? 1 : 0) - slowU) * Math.min(1, dtRaw * 8);
    cb.onAim(mouseAim);

    hudT -= dtRaw;
    if (hudT <= 0) {
      hudT = 0.12;
      pushHud();
    }
    renderFrame();
  }

  function renderFrame() {
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  }

  /* ---------- loop / resize ---------- */
  let raf = 0;
  let last = performance.now();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    step(dt);
  };

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    rt.setSize(size.x, size.y);
    if (rt.depthTexture) rt.depthTexture.dispose();
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
    rt.depthTexture.type = THREE.UnsignedIntType;
    postMat.uniforms.tDepth.value = rt.depthTexture;
    postMat.uniforms.uRes.value.set(size.x, size.y);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  onResize();
  window.addEventListener("resize", onResize);

  /* ---------- input wiring ---------- */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const code = e.code;
    if (["Space", "Tab", "AltLeft", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code)) e.preventDefault();
    keys.add(code);
    if (state !== "playing") {
      if (code === "KeyM") {
        fx.musicOn = !fx.musicOn;
      }
      return;
    }
    switch (code) {
      case "Space":
        if (player.onGround) {
          player.vel.y = XN;
          player.jumps = 1;
        } else if (player.jumps < 2) {
          player.vel.y = XN_AIR;
          player.jumps = 2;
        }
        break;
      case "KeyR":
        startReload();
        break;
      case "KeyQ":
      case "KeyE":
        grappleToggle();
        break;
      case "KeyF":
      case "KeyV":
        if (slots[curSlot].def.katana) tryFocusDash();
        else katanaSlash();
        break;
      case "KeyG":
        throwGrenade();
        break;
      case "KeyX":
      case "AltLeft":
        if (player.dashCd <= 0 && player.grap.active === false) {
          player.dashT = 0.16;
          player.dashCd = 1.4;
          fx.grappleFire();
        }
        break;
      case "Digit1":
        switchSlot(0);
        break;
      case "Digit2":
        switchSlot(1);
        break;
      case "Digit3":
        switchSlot(2);
        break;
      case "Digit4":
        switchSlot(3);
        break;
      case "Digit5":
        switchSlot(4);
        break;
      case "Escape":
      case "KeyP":
        handleRef.current.pause();
        break;
      case "KeyM":
        fx.musicOn = !fx.musicOn;
        break;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);

  const onMouseDown = (e: MouseEvent) => {
    mouseButtons.add(e.button);
    if (state !== "playing") return;
    if (e.button === 0) {
      mouseFire = true;
      if (!slots[curSlot].def.auto) fireWeapon();
    }
    if (e.button === 2) mouseAim = true;
    if (e.button === 1) {
      e.preventDefault();
      grappleToggle();
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    mouseButtons.delete(e.button);
    if (e.button === 0) mouseFire = false;
    if (e.button === 2) mouseAim = false;
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!locked || state !== "playing") return;
    // slider is a percentage: 100% -> 0.0021 rad per mouse count (~1 deg/inch on 800dpi),
    // halving the slider halves the look speed.
    const s = (0.0021 * sensitivity) / 100;
    player.yaw -= e.movementX * s;
    player.pitch -= e.movementY * s * (false ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.5, 1.5);
  };
  const onWheel = (e: WheelEvent) => {
    if (state !== "playing") return;
    e.preventDefault();
    switchSlot((curSlot + (e.deltaY > 0 ? 1 : slots.length - 1)) % slots.length);
  };
  // requestPointerLock returns a Promise in modern browsers; it rejects when
  // called too soon after an Escape-triggered unlock (browser cooldown), so
  // swallow rejections instead of throwing unhandled errors.
  const lockPointer = () => {
    try {
      const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === "function") p.catch(() => void 0);
    } catch {
      /* older browsers may throw synchronously */
    }
  };
  const onContext = (e: Event) => e.preventDefault();
  const onPointerLockChange = () => {
    locked = document.pointerLockElement === canvas;
    if (!locked && state === "playing") handleRef.current.pause();
  };
  const onCanvasClick = () => {
    if (state === "playing" && !locked) lockPointer();
  };
  const onBlur = () => {
    keys.clear();
    mouseFire = false;
    mouseAim = false;
    if (state === "playing") handleRef.current.pause();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("click", onCanvasClick);

  /* ---------- public handle ---------- */
  setViewModel(0);
  const handleRef: { current: GameHandle } = { current: null as unknown as GameHandle };
  const handle: GameHandle = {
    start() {
      resetRun();
      state = "playing";
      intermissionT = 3;
      fx.ensure();
      lockPointer();
      startWave(1);
    },
    pause() {
      if (state !== "playing") return;
      state = "paused";
      keys.clear();
      mouseFire = false;
      mouseAim = false;
      document.exitPointerLock?.();
      cb.onPause({ wave, score });
    },
    resume() {
      if (state !== "paused") return;
      state = "playing";
      last = performance.now();
      cb.onResume();
      lockPointer();
    },
    restart() {
      resetRun();
      state = "playing";
      cb.onResume();
      lockPointer();
      startWave(1);
    },
    toMenu() {
      resetRun();
      state = "menu";
      document.exitPointerLock?.();
      cb.onBoss(null, 0);
      cb.onResume();
    },
    requestLock() {
      if (state === "playing" && !locked) lockPointer();
    },
    setSensitivity(v: number) {
      sensitivity = v;
    },
    setMusic(on: boolean) {
      fx.musicOn = on;
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("click", onCanvasClick);
      renderer.dispose();
      canvas.remove();
    },
  };
  handleRef.current = handle;
  loop();
  return handle;
}
