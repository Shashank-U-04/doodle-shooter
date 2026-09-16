// Doodle District — single-player wave-survival FPS engine (faithful re-creation).
// First-person survival inside a hand-sketched town: toon-shaded boxes on paper with
// real-time ink outlines, wave modifiers, bosses every 5 waves, katana focus meter,
// grapple, grenades, and pickups.

import * as THREE from "three";
import { AudioFX } from "./audio";
import { PAPER_FRAG } from "./shaders";
import {
  INK,
  INK_RGB,
  LIGHT_DIR_WORLD,
  PAPER,
  PAPER_RGB,
  makeInkMaterial,
  resolveMove,
  shared,
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
  // ---- reference AI state ----
  state: "spawn" | "hunt" | "stunned";
  yaw: number;
  yawT: number;
  los: boolean;
  losT: number;
  burstLeft: number;
  burstT: number;
  aimT: number;
  aimAmt: number;
  aimPoint: THREE.Vector3 | null;
  path: THREE.Vector3[] | null;
  pathI: number;
  pathT: number;
  pathGoal: THREE.Vector3 | null;
  stuckT: number;
  hitWall: boolean;
  appAng: number;
  appR: number;
  appT: number;
  keepMul: number;
  strafeDir: number;
  strafeT: number;
  backoffT: number;
  attackT: number;
  attackHit: boolean;
  stunDur: number;
  fuseT: number;
  pathFailT: number;
  laser: THREE.Mesh | null;
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

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PAPER);
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.08, 420);
  scene.add(camera);

  // The scene target is data, not colour: shading, ink id and the surface normal
  // all have to survive the round trip, so it needs a float target at point
  // sampling with a float depth buffer.
  const rt = new THREE.WebGLRenderTarget(4, 4, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.depthTexture = new THREE.DepthTexture(4, 4);
  rt.depthTexture.format = THREE.DepthFormat;
  rt.depthTexture.type = THREE.FloatType;

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
      uPaper: { value: new THREE.Vector3(...PAPER_RGB) },
      uInks: {
        value: [INK.BLUE, INK.RED, INK.BLACK, INK.ORANGE, INK.GREEN, INK.PINK].map(
          (i) => new THREE.Vector3(...INK_RGB[i]),
        ),
      },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uAspect: { value: 1 },
      uLineSpacing: { value: 60 },
      uLineMode: { value: 0 },
      uInvProj: { value: new THREE.Matrix4() },
      uInvView: { value: new THREE.Matrix4() },
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
  let invertY = false;

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
  const DOWN = new THREE.Vector3(0, -1, 0);
  const tmpOffset = new THREE.Vector3();
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
      // pick the far point that is actually standing room: a spawn inside a wall
      // is an enemy nobody can ever reach.
      let best: THREE.Vector3 | null = null;
      let bestD = -1;
      for (let i = 0; i < 14; i++) {
        const sp = pick(district.spawnPoints);
        const d = sp.distanceTo(player.pos);
        if (d < 14 || d <= bestD) continue;
        if (!navOpen(sp.x, sp.z) || pointInSolid(sp.x, 0.2, sp.z, 0.7)) continue;
        bestD = d;
        best = sp;
      }
      if (!best) best = findOpenSpot(player.pos, 22, 40, true) ?? player.pos.clone().setY(0.2);
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
      cooldown: rand(0.6, 1.4),
      t: 0,
      strafe: Math.random() < 0.5 ? 1 : -1,
      dying: 0,
      state: "spawn",
      yaw: rand(0, Math.PI * 2),
      yawT: 0,
      los: false,
      losT: 0,
      burstLeft: 0,
      burstT: 0,
      aimT: 0,
      aimAmt: 0,
      aimPoint: null,
      path: null,
      pathI: 0,
      pathT: 0,
      pathGoal: null,
      stuckT: 0,
      hitWall: false,
      appAng: spawnSlot++ * 2.39996,
      appR: 0,
      appT: rand(0, 2),
      keepMul: rand(0.75, 1.35),
      strafeDir: Math.random() < 0.5 ? 1 : -1,
      strafeT: rand(1, 2),
      backoffT: 0,
      attackT: 0,
      attackHit: false,
      stunDur: 0,
      fuseT: -1,
      pathFailT: 0,
      laser: null,
    };
    built.root.position.copy(pos);
    built.root.rotation.y = rand(0, Math.PI * 2);
    scene.add(built.root);
    enemies.push(e);
    if (def.boss) cb.onBoss(def.name, 1);
    spawnShards(pos.clone().add(new THREE.Vector3(0, 1, 0)), def.ink, 8, 3);
  }

  function explode(pos: THREE.Vector3, radius: number, dmg: number, fromPlayer: boolean) {
    fx.explosion();
    shakeT = Math.max(shakeT, 0.35);
    spawnShards(pos, INK.BLACK, 18, 7);
    spawnShards(pos, INK.ORANGE, 10, 5);
    for (const e of enemies) {
      if (!e.alive) continue;
      const d = e.pos.distanceTo(pos);
      if (d >= radius) continue;
      // falloff by area, like the original
      const f = Math.sqrt(Math.max(0, 1 - d / radius));
      damageEnemy(e, dmg * f * (fromPlayer ? 1.5 : 1), false, fromPlayer ? "blast" : "enemy");
    }
    const pd = player.pos.distanceTo(pos);
    if (pd < radius * 0.8) {
      damagePlayer(dmg * Math.sqrt(Math.max(0, 1 - pd / (radius * 0.8))));
    }
  }

  // keep bodies from stacking up on top of each other (a cheap version of the
  // original's separation pass)
  let sepT = 0;
  function separateEnemies(dt: number) {
    sepT -= dt;
    if (sepT > 0) return;
    sepT = 0.05;
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      if (!a.alive || a.def.flying) continue;
      for (let j = i + 1; j < enemies.length; j++) {
        const b = enemies[j];
        if (!b.alive || b.def.flying) continue;
        if (Math.abs(b.pos.y - a.pos.y) > 1.5) continue;
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d2 = dx * dx + dz * dz;
        const minD = 0.45 * a.def.scale + 0.45 * b.def.scale + 0.75;
        if (d2 > minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const f = (minD - d) * 9 * dt;
        a.pos.x -= (dx / d) * f;
        a.pos.z -= (dz / d) * f;
        b.pos.x += (dx / d) * f;
        b.pos.z += (dz / d) * f;
      }
    }
  }

  /* ---------- navigation grid ---------- */
  // A coarse walkability map of the arena, so an enemy routes around a building
  // instead of leaning into a wall forever. Low geometry (stairs, kerbs) stays
  // walkable; anything tall at body height blocks a cell.
  const NAV_CELL = 2;
  const navMinX = world.bounds.minX - 2;
  const navMinZ = world.bounds.minZ - 2;
  const navW = Math.max(2, Math.ceil((world.bounds.maxX + 2 - navMinX) / NAV_CELL));
  const navH = Math.max(2, Math.ceil((world.bounds.maxZ + 2 - navMinZ) / NAV_CELL));
  const navBlocked = new Uint8Array(navW * navH);
  const navG = new Float32Array(navW * navH);
  const navF = new Float32Array(navW * navH);
  const navFrom = new Int32Array(navW * navH);
  const navSeen = new Int32Array(navW * navH);
  const navDone = new Int32Array(navW * navH);
  let navEpoch = 0;
  let spawnSlot = 0;

  const navIdx = (cx: number, cz: number) => cz * navW + cx;
  const navCellX = (x: number) => clamp(Math.floor((x - navMinX) / NAV_CELL), 0, navW - 1);
  const navCellZ = (z: number) => clamp(Math.floor((z - navMinZ) / NAV_CELL), 0, navH - 1);
  function navOpen(x: number, z: number) {
    return navBlocked[navIdx(navCellX(x), navCellZ(z))] === 0;
  }

  // is this spot inside a wall/block rather than standing room?
  function pointInSolid(x: number, y: number, z: number, pad = 0.5) {
    for (const c of world.colliders) {
      if (c.maxY - 0.2 <= 0.55) continue; // floor and steps are fine
      if (x > c.minX - pad && x < c.maxX + pad && z > c.minZ - pad && z < c.maxZ + pad && y > c.minY - pad && y < c.maxY) {
        return true;
      }
    }
    return false;
  }

  // a spot on open ground, a sensible distance from the player and reachable
  // from there — used to drop an enemy back in when it has been walled away
  function findOpenSpot(center: THREE.Vector3, minD: number, maxD: number, needPath: boolean) {
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(minD, maxD);
      const x = clamp(center.x + Math.cos(a) * r, world.bounds.minX, world.bounds.maxX);
      const z = clamp(center.z + Math.sin(a) * r, world.bounds.minZ, world.bounds.maxZ);
      if (!navOpen(x, z) || pointInSolid(x, 0.2, z, 0.7)) continue;
      const p = new THREE.Vector3(x, 0.2, z);
      if (needPath && !navFindPath(p, center.clone().setY(0.2))) continue;
      return p;
    }
    return null;
  }

  for (let cz = 0; cz < navH; cz++) {
    for (let cx = 0; cx < navW; cx++) {
      const x0 = navMinX + cx * NAV_CELL;
      const z0 = navMinZ + cz * NAV_CELL;
      const x1 = x0 + NAV_CELL;
      const z1 = z0 + NAV_CELL;
      let blocked = 0;
      for (const c of world.colliders) {
        if (c.maxY - 0.2 <= 0.55) continue; // walkable step or kerb
        if (c.minY > 2.2) continue; // overhead deck
        if (c.maxX <= x0 || c.minX >= x1 || c.maxZ <= z0 || c.minZ >= z1) continue;
        blocked = 1;
        break;
      }
      navBlocked[navIdx(cx, cz)] = blocked;
    }
  }

  function navFindPath(from: THREE.Vector3, goal: THREE.Vector3): THREE.Vector3[] | null {
    const startI = navIdx(navCellX(from.x), navCellZ(from.z));
    let gx = navCellX(goal.x);
    let gz = navCellZ(goal.z);
    let goalI = navIdx(gx, gz);
    if (navBlocked[goalI]) {
      let bestD = Infinity;
      let bestI = -1;
      for (let r = 1; r <= 5 && bestI < 0; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nz < 0 || nx >= navW || nz >= navH) continue;
            const i = navIdx(nx, nz);
            if (navBlocked[i]) continue;
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              bestI = i;
            }
          }
        }
      }
      if (bestI < 0) return null;
      goalI = bestI;
      gx = goalI % navW;
      gz = (goalI - gx) / navW;
    }
    if (startI === goalI) return null;

    navEpoch++;
    const heap: number[] = [];
    const heur = (i: number) => {
      const cx = i % navW;
      const cz = (i - cx) / navW;
      return Math.hypot(cx - gx, cz - gz);
    };
    navSeen[startI] = navEpoch;
    navG[startI] = 0;
    navF[startI] = heur(startI);
    navFrom[startI] = -1;
    heap.push(startI);
    const push = (i: number) => {
      heap.push(i);
      let k = heap.length - 1;
      while (k > 0) {
        const par = (k - 1) >> 1;
        if (navF[heap[k]] < navF[heap[par]]) {
          const tmp = heap[k];
          heap[k] = heap[par];
          heap[par] = tmp;
          k = par;
        } else break;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop() as number;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && navF[heap[l]] < navF[heap[m]]) m = l;
          if (r < heap.length && navF[heap[r]] < navF[heap[m]]) m = r;
          if (m === k) break;
          const tmp = heap[k];
          heap[k] = heap[m];
          heap[m] = tmp;
          k = m;
        }
      }
      return top;
    };

    let guard = 0;
    while (heap.length && guard++ < 4000) {
      const cur = pop();
      if (navDone[cur] === navEpoch) continue;
      navDone[cur] = navEpoch;
      if (cur === goalI) break;
      const cx = cur % navW;
      const cz = (cur - cx) / navW;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= navW || nz >= navH) continue;
          const ni = navIdx(nx, nz);
          if (navBlocked[ni]) continue;
          // never cut a corner through a blocked cell
          if (dx !== 0 && dz !== 0 && (navBlocked[navIdx(cx + dx, cz)] || navBlocked[navIdx(cx, cz + dz)])) continue;
          const ng = navG[cur] + (dx !== 0 && dz !== 0 ? 1.41421 : 1);
          if (navSeen[ni] === navEpoch && ng >= navG[ni]) continue;
          navSeen[ni] = navEpoch;
          navG[ni] = ng;
          navFrom[ni] = cur;
          navF[ni] = ng + heur(ni);
          push(ni);
        }
      }
    }
    if (navDone[goalI] !== navEpoch) return null;

    const pts: THREE.Vector3[] = [];
    let i = goalI;
    while (i !== startI && i >= 0 && pts.length < 200) {
      const cx = i % navW;
      const cz = (i - cx) / navW;
      pts.push(new THREE.Vector3(navMinX + (cx + 0.5) * NAV_CELL, 0.2, navMinZ + (cz + 0.5) * NAV_CELL));
      i = navFrom[i];
    }
    pts.reverse();
    return pts;
  }

  const tmpLosFrom = new THREE.Vector3();
  const tmpLosDir = new THREE.Vector3();
  function losClear(from: THREE.Vector3, to: THREE.Vector3) {
    tmpLosDir.copy(to).sub(from);
    const len = tmpLosDir.length();
    if (len < 0.2) return true;
    tmpLosDir.divideScalar(len);
    for (const c of world.colliders) {
      if (c.maxY <= 0.35) continue; // the floor never blocks sight
      const t = rayAABB(from, tmpLosDir, c, len);
      if (t >= 0 && t < len - 0.15) return false;
    }
    return true;
  }

  function groundAhead(e: Enemy, dx: number, dz: number) {
    const px = e.pos.x + dx * 0.9;
    const py = e.pos.y + 0.5;
    const pz = e.pos.z + dz * 0.9;
    tmpLosFrom.set(px, py, pz);
    for (const c of world.colliders) {
      if (rayAABB(tmpLosFrom, DOWN, c, 3.5) >= 0) return true;
    }
    return false;
  }

  function steer(e: Enemy, dt: number, tx: number, tz: number, speed: number, accel: number) {
    let dx = tx - e.pos.x;
    let dz = tz - e.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) {
      e.vel.x *= Math.max(0, 1 - 8 * dt);
      e.vel.z *= Math.max(0, 1 - 8 * dt);
      return;
    }
    dx /= d;
    dz /= d;
    const want = speed * modSpeed;
    const a = (e.onGround ? accel : accel * 0.3) * dt;
    e.vel.x += clamp(dx * want - e.vel.x, -a, a);
    e.vel.z += clamp(dz * want - e.vel.z, -a, a);
    e.yawT = Math.atan2(dx, dz);
  }

  // where the enemy wants to be: a spot circling the player, kept at a distance
  // that depends on its weapon (a rusher closes right in, a rifleman stands off)
  function approachPoint(e: Enemy, dt: number, target: THREE.Vector3) {
    e.appT -= dt;
    if (e.appT <= 0) {
      e.appT = rand(2.5, 5);
      e.appAng += rand(-0.7, 0.7);
      const close = e.def.weapon === "blade" || e.def.weapon === "bomb";
      e.appR = close ? rand(2, 4.5) : rand(4.5, 9);
    }
    const d = Math.hypot(target.x - e.pos.x, target.z - e.pos.z);
    let r = clamp(d * 0.55, Math.min(2, d * 0.9), e.appR);
    if (Math.abs(target.y - e.pos.y) > 1.5) r = Math.min(r, 1.1);
    return new THREE.Vector3(target.x + Math.cos(e.appAng) * r, target.y, target.z + Math.sin(e.appAng) * r);
  }

  function follow(e: Enemy, dt: number, target: THREE.Vector3, speed: number) {
    const goal = approachPoint(e, dt, target);
    e.pathT -= dt;
    if (e.pathT <= 0 || !e.path || e.pathI >= e.path.length || (e.pathGoal && e.pathGoal.distanceTo(goal) > 3.5)) {
      if (e.pathT <= 0 || !e.path) {
        e.pathT = 0.8 + rand(0, 0.6);
        const p = navFindPath(e.pos, goal);
        if (p && p.length) {
          e.path = p;
          e.pathI = 0;
          e.pathGoal = goal.clone();
          while (e.pathI < p.length - 1 && Math.hypot(p[e.pathI].x - e.pos.x, p[e.pathI].z - e.pos.z) < 0.7) e.pathI++;
        }
      }
    }
    let wp: THREE.Vector3 | null = null;
    if (e.path && e.pathI < e.path.length) {
      const h = e.path[e.pathI];
      if (Math.hypot(h.x - e.pos.x, h.z - e.pos.z) < 0.5) {
        e.pathI++;
        if (e.pathI < e.path.length) wp = e.path[e.pathI];
      } else wp = h;
    }
    if (!wp) wp = goal;
    steer(e, dt, wp.x, wp.z, speed, 40);
    const wd = Math.hypot(wp.x - e.pos.x, wp.z - e.pos.z);
    if (e.onGround) {
      if (wp.y > e.pos.y + 0.6 && wd < 1.7) {
        e.vel.y = 9;
        e.onGround = false;
      } else if (e.hitWall) {
        e.stuckT += dt;
        if (e.stuckT > 0.35 && e.stuckT < 0.4) e.pathT = 0;
        if (e.stuckT > 0.9) {
          e.vel.y = 9;
          e.onGround = false;
          e.stuckT = 0;
          e.pathT = 0;
          e.path = null;
        }
      } else e.stuckT = 0;
    } else if (e.hitWall) {
      e.stuckT += dt;
    }
  }

  /* ---------- enemy weapons ---------- */
  const laserMat = makeInkMaterial(INK.RED, true);
  const laserGeo = new THREE.BoxGeometry(0.05, 0.05, 1);
  function showLaser(e: Enemy, aim: THREE.Vector3, progress: number) {
    if (!e.laser) {
      e.laser = new THREE.Mesh(laserGeo, laserMat);
      e.laser.frustumCulled = false;
      scene.add(e.laser);
    }
    const from = e.pos.clone().add(new THREE.Vector3(0, 1.55 * e.def.scale, 0));
    const dir = aim.clone().sub(from);
    const len = dir.length();
    if (len < 2) {
      e.laser.visible = false;
      return;
    }
    e.laser.visible = true;
    e.laser.position.copy(from).addScaledVector(dir, 0.5);
    e.laser.lookAt(aim);
    const w = 1 + progress * 2;
    e.laser.scale.set(w, w, len);
  }
  function hideLaser(e: Enemy) {
    if (e.laser) e.laser.visible = false;
  }
  function dropLaser(e: Enemy) {
    if (e.laser) {
      scene.remove(e.laser);
      e.laser = null;
    }
  }

  function enemyFire(e: Enemy, aim: THREE.Vector3, spread: number, speed: number, dmg: number, ink: InkId) {
    const from = e.pos.clone().add(new THREE.Vector3(0, 1.55 * e.def.scale, 0));
    const dir = aim.clone().sub(from).normalize();
    dir.x += rand(-spread, spread);
    dir.y += rand(-spread, spread);
    dir.z += rand(-spread, spread);
    spawnBullet(from, dir.normalize().multiplyScalar(speed), dmg, false, ink, "enemy");
  }

  function enemyAttack(e: Enemy, dt: number) {
    const def = e.def;
    const w = def.weapon;
    const aim = eyePos();
    const speed = def.pspeed ?? 42;
    const spread = def.spread ?? 0.05;
    const dmg = def.dmg * modDmg;
    const ink: InkId = w === "sniper" ? INK.GREEN : INK.RED;

    // the sniper lines you up with a laser first, then takes one hard, accurate shot
    if (w === "sniper") {
      if (e.cooldown > 0) {
        hideLaser(e);
        return;
      }
      const aimTime = def.aimTime ?? 1.7;
      e.aimT += dt;
      e.aimPoint = e.aimPoint ? e.aimPoint.lerp(aim, 1 - Math.exp(-2.6 * dt)) : aim.clone();
      showLaser(e, e.aimPoint, clamp(e.aimT / aimTime, 0, 1));
      if (e.aimT >= aimTime) {
        e.aimT = 0;
        e.cooldown = rand(def.cool[0], def.cool[1]);
        enemyFire(e, e.aimPoint, spread, speed, dmg, ink);
        fx.sniper();
        hideLaser(e);
        e.aimPoint = null;
      }
      return;
    }

    // everyone else fires a burst, one shot every burstInt
    if (e.burstLeft > 0) {
      e.burstT -= dt;
      if (e.burstT <= 0) {
        e.burstT = def.burstInt ?? 0.15;
        e.burstLeft--;
        enemyFire(e, aim, spread, speed, dmg, ink);
        fx.enemyShot();
        if (e.burstLeft === 0) e.cooldown = rand(def.cool[0], def.cool[1]);
      }
      return;
    }
    if (e.cooldown <= 0) {
      if (w === "shotgun") {
        for (let i = 0; i < (def.pellets ?? 7); i++) enemyFire(e, aim, spread, speed * rand(0.85, 1.1), dmg, ink);
        fx.shotgun();
        e.cooldown = rand(def.cool[0], def.cool[1]);
      } else {
        e.burstLeft = Math.max(1, def.burst ?? 2);
        e.burstT = 0;
      }
    }
  }

  function updateRanged(e: Enemy, dt: number, dx: number, dz: number, dist: number, dy: number, target: THREE.Vector3) {
    const def = e.def;
    const g = Math.atan2(dx, dz);
    if (e.los && dist < def.range) {
      e.aimAmt = Math.min(1, e.aimAmt + dt * 8);
      e.yawT = g;
      if (!def.stationary) {
        const ox = dist > 1e-4 ? dx / dist : 0;
        const oz = dist > 1e-4 ? dz / dist : 0;
        if (dist > def.stop * e.keepMul) {
          follow(e, dt, target, def.speed * 0.8);
          e.yawT = g;
          enemyAttack(e, dt);
          return;
        }
        if (Math.abs(dy) > 1.2) {
          follow(e, dt, target, def.speed * 0.85);
          e.yawT = g;
          enemyAttack(e, dt);
          return;
        }
        let mx = 0;
        let mz = 0;
        if (dist < def.keep * e.keepMul) {
          mx = -ox;
          mz = -oz;
        } else if (dist > def.range * 0.7 && def.weapon === "shotgun") {
          mx = ox;
          mz = oz;
        } else {
          e.strafeT -= dt;
          if (e.strafeT <= 0) {
            e.strafeT = rand(0.8, 2);
            e.strafeDir *= -1;
          }
          mx = -oz * e.strafeDir;
          mz = ox * e.strafeDir;
        }
        const sp = def.weapon === "shotgun" ? def.speed : def.speed * 0.5;
        if ((mx !== 0 || mz !== 0) && groundAhead(e, mx, mz)) {
          const a = 30 * dt;
          e.vel.x += clamp(mx * sp - e.vel.x, -a, a);
          e.vel.z += clamp(mz * sp - e.vel.z, -a, a);
        } else {
          e.vel.x *= Math.max(0, 1 - 8 * dt);
          e.vel.z *= Math.max(0, 1 - 8 * dt);
        }
      }
      enemyAttack(e, dt);
    } else {
      e.aimAmt = Math.max(0, e.aimAmt - dt * 5);
      e.burstLeft = 0;
      e.aimT = 0;
      e.aimPoint = null;
      hideLaser(e);
      if (def.stationary && e.t < 5) {
        e.vel.x *= Math.max(0, 1 - 8 * dt);
        e.vel.z *= Math.max(0, 1 - 8 * dt);
        e.yawT = g;
      } else {
        follow(e, dt, target, def.speed);
      }
    }
    if (e.los) e.yawT = g;
  }

  function updateRusher(e: Enemy, dt: number, dx: number, dz: number, dist: number, dy: number, target: THREE.Vector3) {
    const def = e.def;
    e.aimAmt = Math.max(0, e.aimAmt - dt * 8);
    const g = Math.atan2(dx, dz);
    const d = dist > 1e-4 ? dist : 1;
    if (e.backoffT > 0) {
      e.backoffT -= dt;
      e.yawT = g;
      const a = 26 * dt;
      e.vel.x += clamp(-(dx / d) * def.speed * 0.55 - e.vel.x, -a, a);
      e.vel.z += clamp(-(dz / d) * def.speed * 0.55 - e.vel.z, -a, a);
      return;
    }
    if (e.attackT > 0) {
      e.attackT -= dt;
      e.vel.x *= Math.max(0, 1 - 8 * dt);
      e.vel.z *= Math.max(0, 1 - 8 * dt);
      e.yawT = g;
      if (e.attackT < 0.18 && !e.attackHit) {
        e.attackHit = true;
        if (dist < (def.reach ?? 3) && Math.abs(dy) < 1.7) {
          damagePlayer(def.dmg * modDmg, new THREE.Vector3(dx / d, 0.2, dz / d));
        }
      }
      if (e.attackT <= 0) {
        e.cooldown = rand(def.cool[0], def.cool[1]);
        e.backoffT = rand(0.45, 0.75);
      }
      return;
    }
    if (dist < (def.lunge ?? 2.9) && Math.abs(dy) < 1.7 && e.cooldown <= 0 && e.los) {
      e.attackT = 0.55;
      e.attackHit = false;
      e.vel.x += (dx / d) * 2.5;
      e.vel.z += (dz / d) * 2.5;
      return;
    }
    if (e.los && dist < 9 && Math.abs(dy) < 1.6) {
      if (dist < (def.standoff ?? 1.9) && Math.abs(dy) < 1.2) {
        const a = 24 * dt;
        e.vel.x += clamp(-(dx / d) * def.speed * 0.4 - e.vel.x, -a, a);
        e.vel.z += clamp(-(dz / d) * def.speed * 0.4 - e.vel.z, -a, a);
        e.yawT = g;
      } else {
        const p = dist > 4.5 ? approachPoint(e, dt, target) : target;
        steer(e, dt, p.x, p.z, def.speed, 45);
        if (e.onGround && e.hitWall) {
          e.stuckT += dt;
          if (e.stuckT > 0.25) {
            e.vel.y = 9;
            e.onGround = false;
            e.stuckT = 0;
          }
        }
      }
    } else {
      follow(e, dt, target, def.speed);
    }
  }

  function updateFlyer(e: Enemy, dt: number, dist: number) {
    const orbit = Math.atan2(e.pos.x - player.pos.x, e.pos.z - player.pos.z) + 0.45;
    const r = 11;
    const goal = new THREE.Vector3(
      player.pos.x + Math.sin(orbit) * r,
      player.pos.y + 6 + Math.sin(e.t * 1.3) * 1.5,
      player.pos.z + Math.cos(orbit) * r,
    );
    const to = goal.sub(e.pos);
    const len = to.length();
    if (len > 0.3) {
      to.divideScalar(len).multiplyScalar(e.def.speed * modSpeed);
      e.vel.lerp(to, Math.min(1, dt * 3));
    } else {
      e.vel.multiplyScalar(Math.max(0, 1 - 4 * dt));
    }
    e.yawT = Math.atan2(e.vel.x, e.vel.z);
    // dive at the player when the cooldown is up and they are near
    if (e.cooldown <= 0 && dist < 14) {
      const dive = player.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(e.pos).normalize();
      e.vel.addScaledVector(dive, e.def.speed * dt * 3.4);
      if (dist < 2.2) {
        damagePlayer(e.def.dmg * modDmg, dive);
        e.vel.addScaledVector(dive, -12);
        e.cooldown = rand(e.def.cool[0], e.def.cool[1]);
      }
    }
  }

  function updateEnemy(e: Enemy, dt: number) {
    e.t += dt;
    if (!e.alive) {
      e.dying -= dt;
      e.torso.rotation.x = Math.min(1.5, e.torso.rotation.x + dt * 6);
      e.root.position.y -= dt * 1.2;
      hideLaser(e);
      if (e.dying <= 0) scene.remove(e.root);
      return;
    }
    // pop-in, exactly like the original: a quick scale-up wobble
    if (e.state === "spawn") {
      const k = clamp(e.t / 0.6, 0, 1);
      e.root.scale.setScalar(Math.max(0.001, k * e.def.scale * (1 + Math.sin(e.t * 60) * 0.12 * (1 - k))));
      e.root.position.copy(e.pos);
      e.root.rotation.y = e.yaw;
      if (e.t >= 0.6) {
        e.state = "hunt";
        e.root.scale.setScalar(e.def.scale);
      }
      return;
    }

    const target = player.pos;
    const dx = target.x - e.pos.x;
    const dz = target.z - e.pos.z;
    const dist = Math.hypot(dx, dz);
    const dy = target.y - e.pos.y;

    // line of sight, refreshed on a short stagger like the original does
    e.losT -= dt;
    if (e.losT <= 0) {
      e.losT = 0.12 + rand(0, 0.1);
      tmpLosFrom.copy(e.pos).add(tmpOffset.set(0, 1.55 * e.def.scale, 0));
      e.los = losClear(tmpLosFrom, eyePos());
    }
    e.cooldown -= dt;

    if (e.state === "stunned") {
      e.stunDur -= dt;
      e.vel.x *= Math.max(0, 1 - 6 * dt);
      e.vel.z *= Math.max(0, 1 - 6 * dt);
      if (e.stunDur <= 0) e.state = "hunt";
    } else if (e.def.flying) {
      updateFlyer(e, dt, dist);
      e.pos.addScaledVector(e.vel, dt);
      e.pos.x = clamp(e.pos.x, world.bounds.minX, world.bounds.maxX);
      e.pos.z = clamp(e.pos.z, world.bounds.minZ, world.bounds.maxZ);
      e.pos.y = clamp(e.pos.y, 1.6, 15);
      e.yaw += (e.yawT - e.yaw) * (1 - Math.exp(-8 * dt));
      e.root.position.copy(e.pos);
      e.root.rotation.y = e.yaw;
      e.root.rotation.z = Math.sin(e.t * 12) * 0.12;
      return;
    } else if (e.def.weapon === "bomb") {
      if (e.fuseT >= 0) {
        e.fuseT -= dt;
        e.vel.x *= Math.max(0, 1 - 4 * dt);
        e.vel.z *= Math.max(0, 1 - 4 * dt);
        e.yawT = Math.atan2(dx, dz);
        if (e.fuseT <= 0) {
          explode(e.pos.clone().add(new THREE.Vector3(0, 0.8, 0)), e.def.blast ?? 4.2, e.def.dmg, false);
          killEnemy(e, "self", false);
          dropLaser(e);
          return;
        }
      } else if (dist < (e.def.fuseRange ?? 3.4) && Math.abs(dy) < 2.2 && e.los) {
        e.fuseT = e.def.fuse ?? 1.05;
      } else if (e.los && dist < 12 && Math.abs(dy) < 1.5) {
        steer(e, dt, target.x, target.z, e.def.speed, 45);
      } else {
        follow(e, dt, target, e.def.speed);
      }
    } else if (e.def.weapon === "blade") {
      updateRusher(e, dt, dx, dz, dist, dy, target);
    } else {
      updateRanged(e, dt, dx, dz, dist, dy, target);
    }

    // If this one has been walled away from the player — no route, no sight line,
    // far away — drop it back onto open ground rather than stall the wave.
    e.pathFailT = e.path && e.pathI < e.path.length ? 0 : e.pathFailT + dt;
    if (e.pathFailT > 7 && dist > 26 && !e.los) {
      const spot = findOpenSpot(player.pos, 20, 34, true);
      if (spot) {
        e.pos.copy(spot);
        e.vel.set(0, 0, 0);
        e.path = null;
        e.pathGoal = null;
        e.pathFailT = 0;
        e.state = "spawn";
        e.t = 0;
        e.root.position.copy(e.pos);
        return;
      }
    }

    e.vel.y -= 24 * dt;
    const rmov = resolveMove(e.pos, e.vel, 0.45 * e.def.scale, 1.85 * e.def.scale, world.colliders, dt);
    e.onGround = rmov.onGround;
    e.hitWall = rmov.hitWall;
    e.pos.x = clamp(e.pos.x, world.bounds.minX, world.bounds.maxX);
    e.pos.z = clamp(e.pos.z, world.bounds.minZ, world.bounds.maxZ);
    if (e.pos.y < -6) {
      killEnemy(e, "self", false);
      dropLaser(e);
      return;
    }

    e.yaw += (e.yawT - e.yaw) * (1 - Math.exp(-10 * dt));

    // don't stand inside the player
    const rad = 0.36 + 0.45 * e.def.scale + 0.12;
    const px = e.pos.x - target.x;
    const pz = e.pos.z - target.z;
    const pd = Math.hypot(px, pz);
    if (pd < rad && pd > 1e-4 && Math.abs(e.pos.y - target.y) < 1.7) {
      const push = (rad - pd) / pd;
      e.pos.x += px * push;
      e.pos.z += pz * push;
    }

    e.root.position.copy(e.pos);
    e.root.rotation.y = e.yaw;

    // limbs
    const spd = Math.hypot(e.vel.x, e.vel.z);
    const sw = spd > 0.4 ? Math.sin(e.t * 10) * 0.5 : 0;
    e.legL.rotation.x = sw;
    e.legR.rotation.x = -sw;
    e.armL.rotation.x = -sw * 0.6;
    if (e.armR.rotation.x < -0.1) e.armR.rotation.x += dt * 6;
    else e.armR.rotation.x = sw * 0.6;
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
    // -1 when nothing is hit: callers treat "no hit" as a miss, so bullets keep
    // flying instead of dying on the end of their own step.
    let best = -1;
    for (const c of world.colliders) {
      const t = rayAABB(origin, dir, c, best < 0 ? maxDist : best);
      if (t >= 0 && (best < 0 || t < best)) best = t;
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
    // minimap: every live enemy in the player's own frame, up = where you look
    const blips: { x: number; z: number; boss: boolean }[] = [];
    {
      const cy = Math.cos(player.yaw);
      const sy = Math.sin(player.yaw);
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = e.pos.x - player.pos.x;
        const dz = e.pos.z - player.pos.z;
        const fwd = dx * -sy + dz * -cy; // forward is (-sin yaw, -cos yaw)
        const right = dx * cy - dz * sy;
        blips.push({ x: clamp(right / 62, -1, 1), z: clamp(-fwd / 62, -1, 1), boss: !!e.def.boss });
        if (blips.length >= 24) break;
      }
    }
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
      blips,
    };
    cb.onHud(hud);
  }

  /* ---------- state transitions ---------- */
  function resetRun() {
    for (const e of enemies) {
      scene.remove(e.root);
      dropLaser(e);
    }
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
    separateEnemies(dt);
    // cull fully-dead
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (!enemies[i].alive && enemies[i].dying <= -0.1) {
        dropLaser(enemies[i]);
        enemies.splice(i, 1);
      }
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
    const t = performance.now() * 0.001;
    shared.uTime.value = t;
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    // the sketch light lives in view space, so shading is anchored to the camera
    shared.uLightDir.value.copy(LIGHT_DIR_WORLD).transformDirection(camera.matrixWorldInverse);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const u = postMat.uniforms;
    u.uTime.value = t;
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uInvView.value.copy(camera.matrixWorld);
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
    district.update(now * 0.001);
    step(dt);
  };

  const onResize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    rt.setSize(size.x, size.y);
    if (rt.depthTexture) rt.depthTexture.dispose();
    const depth = new THREE.DepthTexture(size.x, size.y);
    depth.format = THREE.DepthFormat;
    depth.type = THREE.FloatType;
    rt.depthTexture = depth;
    postMat.uniforms.tDepth.value = depth;
    postMat.uniforms.uRes.value.set(size.x, size.y);
    postMat.uniforms.uAspect.value = w / h;
    postMat.uniforms.uLineSpacing.value = size.y / 13.5;
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
    player.pitch -= e.movementY * s * (invertY ? -1 : 1);
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
    setInvert(on: boolean) {
      invertY = on;
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
