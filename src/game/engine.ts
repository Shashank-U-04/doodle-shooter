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
import type { EngineCallbacks, GameHandle, HudState, NetPlayerState, NetRemotePlayer } from "./types";

THREE.ColorManagement.enabled = false;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
type Enemy = {
  kind: EnemyKind;
  def: EnemyDef;
  root: THREE.Group;
  head: THREE.Object3D;
  torso: THREE.Object3D;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  shinL: THREE.Object3D;
  shinR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  foreL: THREE.Object3D;
  foreR: THREE.Object3D;
  hips: THREE.Object3D;
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
  valveT: number;
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
  // ---- boss / wasp special attacks ----
  bossAtk: BossAtk | null;
  bossCharges: number;
  bossSprays: number;
  hopT: number;
  hopping: boolean;
  flyState: "orbit" | "dive" | "stunned";
  flyT: number;
  diveHit: boolean;
};

type BossAtk = {
  kind: "stomp" | "throw" | "charge" | "rub" | "spray" | "summon";
  t: number;
  done: boolean;
  dir: THREE.Vector3 | null;
  hit: boolean;
  shots: number;
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
  // Pointer capture is a nicety, never a requirement. Mouse look runs on plain
  // mouse movement (see onMouseMove), so a frame that refuses the capture costs
  // the player nothing, and the one rule that matters is that a menu, pause or
  // game-over screen hands the cursor back — that is what keeps its buttons
  // clickable.
  // Losing the capture never pauses the game: pause is Esc/P and nothing else,
  // so a run always keeps going and a pointer-lock quirk can never strand the
  // player on a pause screen.
  let sensitivity = 100; // slider percentage; 100 = default look speed
  let invertY = false;
  // Where the cursor is, so the view can still turn when the pointer cannot be
  // captured (see steerFromEdge), plus the previous position so look keeps
  // working in frames that strip the movement deltas from mouse events.
  let cursorX = 0;
  let cursorY = 0;
  let cursorSeen = false;
  let lastCX = 0;
  let lastCY = 0;
  // False the moment the pointer leaves the window, so the edge-steer cannot
  // keep turning the view for a cursor that is not even over the game.
  let pointerInside = false;
  // Dead-capture detector: counts consecutive captured mousemove events that
  // carry no motion data (see the guard in onMouseMove). A granted pointer
  // lock that never reports movement is exactly the "mouse is frozen until I
  // press Esc" bug — the detector drops the dead capture automatically.
  let lockedZeroStreak = 0;
  // When the pointer last produced real look input (ms). "The mouse has been
  // still for a beat" is what lets steerFromEdge tell a cursor deliberately
  // held against the screen edge apart from one just sweeping past it.
  let lastLookMoveMs = 0;
  // How long the cursor has been parked inside an edge band (steerFromEdge).
  let edgeParkT = 0;
  // Refused captures are throttled, not forbidden. A sandboxed preview frame
  // refuses pointer lock outright (SecurityError) and a StrictMode remount can
  // refuse with WrongDocumentError — retrying at every keystroke would spam
  // the console, so after a refusal the next attempt waits for the next real
  // gesture. A normal browser, though, also refuses for a while after Escape
  // ("the user has exited the lock before"), and it must be allowed to capture
  // again once that cooldown passes — that is why this never becomes permanent.
  let lockCooldownUntil = 0;
  let disposed = false;

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
  // Online only: the two flags the net layer broadcasts about us. They are
  // written from the same places the solo game already tracks movement and
  // firing, so nothing about the run itself changes.
  let netMoving = false;
  let netFireT = 0;

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
  // The first-person weapon is the thing the player looks at most, so it gets
  // the same treatment as the enemy rigs: real part-by-part models with gloved
  // hands and sleeves, drawn in the same two inks as the rest of the world.
  const matBody = makeInkMaterial(INK.BLUE, false); // hatched ink: the weapon body
  const matLine = makeInkMaterial(INK.BLACK, false);
  const matMetal = makeInkMaterial(INK.BLACK, true);
  const matAccent = makeInkMaterial(INK.ORANGE, true);
  const matLens = makeInkMaterial(INK.GREEN, true);
  const matGlove = makeInkMaterial(INK.BLACK, true);
  const matSleeve = makeInkMaterial(INK.BLUE, false);
  const viewModels: THREE.Group[] = [];

  const part = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };
  const pbox = (
    p: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ) => part(p, new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz);
  const pcyl = (
    p: THREE.Object3D,
    r1: number,
    r2: number,
    h: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    seg = 10,
  ) => part(p, new THREE.CylinderGeometry(r1, r2, h, seg), mat, x, y, z, rx, ry, rz);
  const ptor = (p: THREE.Object3D, r: number, tube: number, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    part(p, new THREE.TorusGeometry(r, tube, 6, 14), mat, x, y, z, rx, ry, rz);

  /** a gloved fist, with the forearm and cuff running back down toward the camera */
  const hand = (p: THREE.Object3D, x: number, y: number, z: number, flip: number) => {
    pbox(p, 0.082, 0.105, 0.09, matGlove, x, y, z, 0.12, flip * 0.2, 0);
    pbox(p, 0.088, 0.032, 0.108, matGlove, x, y - 0.05, z - 0.012, 0.2, flip * 0.2, 0);
    pbox(p, 0.048, 0.028, 0.05, matMetal, x + flip * 0.03, y + 0.032, z - 0.03, 0.3, 0, 0);
    pcyl(p, 0.058, 0.07, 0.34, matSleeve, x, y - 0.113, z + 0.127, 2.3, flip * 0.22, flip * 0.08);
    pcyl(p, 0.072, 0.078, 0.05, matAccent, x, y - 0.226, z + 0.253, 2.3, flip * 0.22, flip * 0.08);
  };

  const buildViewModel = (kind: string): THREE.Group => {
    const g = new THREE.Group();
    if (kind === "rifle") {
      pbox(g, 0.078, 0.1, 0.44, matBody, 0, 0, -0.16);
      pbox(g, 0.07, 0.08, 0.28, matLine, 0, -0.005, -0.48);
      pbox(g, 0.04, 0.02, 0.3, matMetal, 0, 0.05, -0.44);
      pcyl(g, 0.015, 0.015, 0.34, matMetal, 0, 0.005, -0.78, Math.PI / 2);
      pcyl(g, 0.024, 0.024, 0.07, matMetal, 0, 0.005, -0.97, Math.PI / 2);
      pbox(g, 0.02, 0.05, 0.02, matMetal, 0, 0.045, -0.9);
      pbox(g, 0.055, 0.2, 0.095, matMetal, 0, -0.145, -0.14, 0.16);
      pbox(g, 0.05, 0.13, 0.07, matMetal, 0, -0.1, 0.03, -0.25);
      pbox(g, 0.06, 0.09, 0.22, matBody, 0, -0.015, 0.14);
      pbox(g, 0.07, 0.13, 0.04, matMetal, 0, -0.03, 0.25);
      pbox(g, 0.042, 0.05, 0.16, matMetal, 0, 0.095, -0.14);
      pcyl(g, 0.02, 0.02, 0.02, matLens, 0, 0.095, -0.22, Math.PI / 2);
      pcyl(g, 0.018, 0.018, 0.02, matMetal, 0, 0.095, -0.06, Math.PI / 2);
      pbox(g, 0.03, 0.032, 0.1, matMetal, 0, 0.063, -0.14);
      pbox(g, 0.02, 0.02, 0.06, matMetal, 0.045, 0.028, -0.06);
      hand(g, 0.006, -0.105, 0.025, 1);
      hand(g, -0.012, -0.024, -0.44, -1);
    } else if (kind === "shotgun") {
      pbox(g, 0.09, 0.11, 0.36, matBody, 0, -0.01, -0.1);
      pcyl(g, 0.026, 0.026, 0.6, matMetal, 0, 0.035, -0.62, Math.PI / 2);
      pcyl(g, 0.021, 0.021, 0.44, matMetal, 0, -0.022, -0.55, Math.PI / 2);
      pbox(g, 0.086, 0.075, 0.16, matAccent, 0, -0.026, -0.5);
      for (let i = 0; i < 4; i++) pbox(g, 0.014, 0.03, 0.05, matAccent, 0.05, -0.03 + i * 0.001, -0.2 - i * 0.055);
      pbox(g, 0.06, 0.1, 0.26, matBody, 0, -0.045, 0.16);
      pbox(g, 0.07, 0.14, 0.04, matMetal, 0, -0.055, 0.3);
      pbox(g, 0.05, 0.13, 0.075, matMetal, 0, -0.11, -0.02, -0.22);
      pcyl(g, 0.011, 0.011, 0.03, matMetal, 0, 0.078, -0.9);
      pbox(g, 0.05, 0.026, 0.06, matMetal, 0, 0.062, -0.05, 0, 0, 0.2);
      hand(g, 0.006, -0.115, 0.015, 1);
      hand(g, -0.012, -0.05, -0.5, -1);
    } else if (kind === "sniper") {
      pbox(g, 0.07, 0.1, 0.5, matBody, 0, 0, -0.16);
      pcyl(g, 0.017, 0.017, 0.72, matMetal, 0, 0.005, -0.9, Math.PI / 2);
      pcyl(g, 0.028, 0.028, 0.09, matMetal, 0, 0.005, -1.29, Math.PI / 2);
      pcyl(g, 0.028, 0.028, 0.34, matMetal, 0, 0.1, -0.2, Math.PI / 2);
      pcyl(g, 0.038, 0.038, 0.05, matMetal, 0, 0.1, -0.38, Math.PI / 2);
      pcyl(g, 0.031, 0.031, 0.012, matLens, 0, 0.1, -0.41, Math.PI / 2);
      pcyl(g, 0.032, 0.032, 0.05, matMetal, 0, 0.1, -0.02, Math.PI / 2);
      pcyl(g, 0.016, 0.016, 0.045, matMetal, 0, 0.142, -0.2);
      pcyl(g, 0.014, 0.014, 0.04, matMetal, 0.034, 0.1, -0.2, 0, 0, Math.PI / 2);
      pbox(g, 0.03, 0.05, 0.06, matMetal, 0, 0.058, -0.3);
      pbox(g, 0.03, 0.05, 0.06, matMetal, 0, 0.058, -0.11);
      pbox(g, 0.018, 0.018, 0.09, matMetal, 0.048, 0.022, -0.04, 0.5, 0, 0.4);
      pbox(g, 0.05, 0.1, 0.08, matMetal, 0, -0.1, -0.1);
      pbox(g, 0.055, 0.1, 0.3, matBody, 0, -0.035, 0.2);
      pbox(g, 0.062, 0.045, 0.17, matMetal, 0, 0.038, 0.19);
      pbox(g, 0.05, 0.13, 0.07, matMetal, 0, -0.1, 0.03, -0.22);
      pbox(g, 0.016, 0.016, 0.2, matMetal, -0.045, -0.06, -0.6, 0.35);
      pbox(g, 0.016, 0.016, 0.2, matMetal, 0.045, -0.06, -0.6, 0.35);
      hand(g, 0.006, -0.105, 0.025, 1);
      hand(g, -0.012, -0.03, -0.5, -1);
    } else if (kind === "revolver") {
      pbox(g, 0.036, 0.05, 0.24, matMetal, 0, 0.022, -0.2);
      pbox(g, 0.016, 0.018, 0.22, matMetal, 0, 0.05, -0.2);
      pbox(g, 0.046, 0.07, 0.18, matBody, 0, 0, -0.04);
      pcyl(g, 0.045, 0.045, 0.1, matMetal, 0, 0.006, -0.13, Math.PI / 2, 0, 0, 12);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        pcyl(g, 0.009, 0.009, 0.11, matAccent, 0, 0.006 + Math.cos(a) * 0.028, -0.13 + Math.sin(a) * 0.028, Math.PI / 2, 0, 0, 6);
      }
      pbox(g, 0.05, 0.14, 0.075, matBody, 0, -0.105, 0.05, -0.3);
      pbox(g, 0.02, 0.04, 0.02, matMetal, 0, 0.048, 0.045);
      ptor(g, 0.032, 0.008, matMetal, 0, -0.05, -0.02, Math.PI / 2);
      pbox(g, 0.012, 0.02, 0.012, matMetal, 0, 0.06, -0.31);
      hand(g, 0.01, -0.1, 0.06, 1);
      hand(g, -0.072, -0.072, 0.035, -1);
    } else {
      // katana: wrapped tsuka, tsuba, curved blade
      pcyl(g, 0.02, 0.02, 0.28, matMetal, 0, 0.02, 0.15, Math.PI / 2);
      for (let i = 0; i < 6; i++) pbox(g, 0.03, 0.012, 0.022, matAccent, 0, 0.038, 0.045 + i * 0.042, 0, 0, 0.5);
      pcyl(g, 0.05, 0.05, 0.018, matMetal, 0, 0.02, 0.0, Math.PI / 2, 0, 0, 14);
      pbox(g, 0.03, 0.05, 0.05, matAccent, 0, 0.02, -0.035);
      const blade = pbox(g, 0.018, 0.046, 1.02, matBody, 0, 0.034, -0.55);
      blade.rotation.x = 0.03;
      const edge = pbox(g, 0.008, 0.012, 1.0, matMetal, 0, 0.014, -0.55);
      edge.rotation.x = 0.03;
      pbox(g, 0.014, 0.02, 0.05, matMetal, 0, 0.046, -1.06, 0.03);
      hand(g, 0.004, -0.04, 0.09, 1);
      hand(g, -0.004, -0.05, 0.24, -1);
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
  const pickupGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const pickupBarGeo = new THREE.BoxGeometry(0.5, 0.14, 0.14);
  const nadeGeo = new THREE.BoxGeometry(0.22, 0.22, 0.22);
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
    netFireT = 0.14;
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
    netFireT = 0.2;
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
      damageEnemy(e, headHit ? 999 : 90 * (1 + wave * 0.03), headHit, "katana");
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
    damageEnemy(target, 9999, false, "focus");
    cb.onTip("<b>EXECUTED</b>", 1.2);
  }

  /* ---------- damage ---------- */
  function damageEnemy(e: Enemy, amount: number, crit: boolean, source: string) {
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
    if (e.def.boss) cb.onBoss(e.def.name, clamp(e.hp / e.maxHp, 0, 1));
    spawnShards(e.pos.clone().add(new THREE.Vector3(0, 1.2 * e.def.scale, 0)), crit ? INK.RED : e.def.ink, crit ? 7 : 3, 2.4);
    if (e.hp <= 0) killEnemy(e, source, crit);
    else {
      fx.hitEnemy();
      cb.onHitmarker(false, crit);
    }
    pushHud();
  }

  function killEnemy(e: Enemy, source: string, crit: boolean) {
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

  function damagePlayer(amount: number, fromDir?: THREE.Vector3, killerId: string | null = null) {
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
      if (pvp.active) {
        // A deathmatch death is a wait, not the end of the run: the match and
        // everyone else's game keep going while we sit out the respawn timer.
        mouseFire = false;
        mouseAim = false;
        cb.onNetDeath?.(killerId);
      } else {
        gameOver();
      }
    }
    pushHud();
  }

  function addScore(n: number, feed?: string) {
    score += n;
    if (feed) cb.onKillFeed(feed, n >= 1000);
  }

  /* ---------- enemies ---------- */
  // Every rig merges its own geometry (materials are shared from a global
  // cache), so a discarded enemy must hand those buffers back. Without this
  // every enemy ever spawned stayed resident in GPU memory, which is what
  // wears the renderer down over a long run of waves.
  const deadGeos = new Set<THREE.BufferGeometry>();
  const releaseRig = (root: THREE.Object3D) => {
    root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry;
      if (g) deadGeos.add(g);
    });
    for (const g of deadGeos) g.dispose();
    deadGeos.clear();
  };

  function makeLocalRig(def: EnemyDef) {
    let rigB: Rig;
    if (def.model === "flyer") rigB = makeWaspRig({ ink: def.ink, bodyW: 1, headS: 1, limbR: 0.03, scale: def.scale });
    else if (def.model === "blob") rigB = makeBlobRig({ ink: def.ink, bodyW: 1, headS: 1, limbR: 0.03, scale: def.scale, weapon: def.weapon }, def.bossKind);
    else rigB = makeRig({ ink: def.ink, accent: def.accent ?? INK.BLACK, bodyW: def.bodyW ?? 1, headS: def.headS ?? 1, limbR: def.limbR ?? 0.032, hat: def.hat, shield: def.shield, weapon: def.weapon, scale: def.scale, smile: def.weapon === "blade", vest: def.vest, coat: def.coat, visor: def.visor, bulky: def.bulky, backpack: def.backpack });
    const P = rigB.parts;
    return {
      root: rigB.root,
      head: P.head,
      torso: P.torso,
      hips: P.hips,
      legL: P.legL,
      legR: P.legR,
      shinL: P.shinL,
      shinR: P.shinR,
      armL: P.armL,
      armR: P.armR,
      foreL: P.foreL,
      foreR: P.foreR,
      hatMesh: null,
      shieldMesh: P.shield,
      headY: rigB.headWorldY,
    };
  }
  function spawnEnemy(kind: EnemyKind): Enemy {
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
      hips: built.hips,
      legL: built.legL,
      legR: built.legR,
      shinL: built.shinL,
      shinR: built.shinR,
      armL: built.armL,
      armR: built.armR,
      foreL: built.foreL,
      foreR: built.foreR,
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
      valveT: 0,
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
      bossAtk: null,
      bossCharges: 0,
      bossSprays: 0,
      hopT: 1,
      hopping: false,
      flyState: "orbit",
      flyT: 0,
      diveHit: false,
    };
    built.root.position.copy(pos);
    built.root.rotation.y = rand(0, Math.PI * 2);
    scene.add(built.root);
    enemies.push(e);
    if (def.boss) cb.onBoss(def.name, 1);
    spawnShards(pos.clone().add(new THREE.Vector3(0, 1, 0)), def.ink, 8, 3);
    return e;
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
    // online: a grenade hurts everyone standing in it, not just us
    blastRemotes(pos, radius * 0.8, dmg);
  }

  /* ------------------------------------------------------------------ *
   * Online PvP — additive, and inert unless setPvp(true)
   *
   * Nothing below changes the solo game: every branch is behind `pvp.active`.
   * What the engine gains is exactly three things — it draws the other
   * players, our bullets can hit them, and their bullets can hit us. Movement,
   * weapons, physics, waves and the HUD are the code they already were.
   * ------------------------------------------------------------------ */
  const PVP_INKS: InkId[] = [INK.BLUE, INK.RED, INK.BLACK, INK.ORANGE, INK.GREEN, INK.PINK];

  type RemoteActor = {
    id: string;
    name: string;
    ink: InkId;
    rig: Rig;
    /** drawn position, smoothed towards `target` */
    pos: THREE.Vector3;
    target: THREE.Vector3;
    yaw: number;
    targetYaw: number;
    state: NetPlayerState;
    /** countdown to the next muzzle flash while they hold the trigger */
    fireT: number;
    walk: number;
  };

  const pvp = {
    active: false,
    remotes: new Map<string, RemoteActor>(),
  };

  function dropRemote(a: RemoteActor) {
    scene.remove(a.rig.root);
    releaseRig(a.rig.root);
  }

  function syncRemotePlayers(list: NetRemotePlayer[]) {
    const keep = new Set<string>();
    for (const p of list) {
      keep.add(p.id);
      let a = pvp.remotes.get(p.id);
      if (!a) {
        const ink = PVP_INKS[((p.ink % PVP_INKS.length) + PVP_INKS.length) % PVP_INKS.length];
        const built = makeRig({ ink, bodyW: 1, headS: 1, limbR: 0.032, weapon: "rifle", scale: 1, vest: true });
        built.root.position.set(p.state.x, p.state.y, p.state.z);
        built.root.rotation.y = p.state.yaw + Math.PI;
        scene.add(built.root);
        a = {
          id: p.id,
          name: p.name,
          ink,
          rig: built,
          pos: new THREE.Vector3(p.state.x, p.state.y, p.state.z),
          target: new THREE.Vector3(p.state.x, p.state.y, p.state.z),
          yaw: p.state.yaw,
          targetYaw: p.state.yaw,
          state: p.state,
          fireT: 0,
          walk: 0,
        };
        pvp.remotes.set(p.id, a);
      }
      a.name = p.name;
      a.state = p.state;
      a.target.set(p.state.x, p.state.y, p.state.z);
      a.targetYaw = p.state.yaw;
    }
    for (const [id, a] of [...pvp.remotes]) {
      if (keep.has(id)) continue;
      dropRemote(a);
      pvp.remotes.delete(id);
    }
  }

  function updateRemoteActors(dt: number) {
    for (const a of pvp.remotes.values()) {
      const s = a.state;
      // Updates arrive at ~20 Hz; the avatar is drawn where the packet says
      // they are, eased so a 50 ms gap reads as motion instead of a stutter.
      // A jump bigger than a room is a respawn, not movement — snap to it
      // rather than sliding the body across the whole district.
      if (a.pos.distanceToSquared(a.target) > 144) a.pos.copy(a.target);
      else a.pos.lerp(a.target, Math.min(1, dt * 14));
      let dy = a.targetYaw - a.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      a.yaw += dy * Math.min(1, dt * 14);
      a.rig.root.position.copy(a.pos);
      // the rigs are modelled facing +Z, the player convention faces -Z
      a.rig.root.rotation.y = a.yaw + Math.PI;
      a.rig.root.visible = s.alive;
      if (!s.alive) continue;

      const P = a.rig.parts;
      a.walk += dt * (s.moving ? 9 : 2.2);
      const swing = Math.sin(a.walk) * 0.5 * (s.moving ? 1 : 0.12);
      P.legL.rotation.x = swing;
      P.legR.rotation.x = -swing;
      P.armL.rotation.x = -swing * 0.7;
      P.armR.rotation.x = swing * 0.7;
      P.torso.rotation.y = Math.sin(a.walk * 0.5) * 0.06 * (s.moving ? 1 : 0);

      // muzzle ink: a splash the moment they start, then a flicker for as long
      // as the trigger is held, so a burst reads as a burst
      a.fireT -= dt;
      if (!s.firing) a.fireT = 0;
      else if (a.fireT <= 0) {
        a.fireT = 0.09;
        const dir = new THREE.Vector3(Math.sin(a.yaw + Math.PI), 0, Math.cos(a.yaw + Math.PI));
        const m = a.pos.clone().add(new THREE.Vector3(0, 1.25, 0)).addScaledVector(dir, 0.5);
        spawnShards(m, a.ink, 3, 2.2);
        spawnShards(m.clone().addScaledVector(dir, 3.5), a.ink, 1, 1.4);
      }
    }
  }

  /** our rounds against the other players; true when the round is spent */
  function hitRemoteSegment(from: THREE.Vector3, to: THREE.Vector3, b: Bullet): boolean {
    if (!pvp.active) return false;
    const seg = to.clone().sub(from);
    const segLen = seg.length();
    if (segLen < 1e-6) return false;
    const segDir = seg.clone().divideScalar(segLen);
    for (const a of pvp.remotes.values()) {
      if (!a.state.alive) continue;
      const headC = a.pos.clone().add(new THREE.Vector3(0, 1.5, 0));
      const toH = headC.clone().sub(from);
      const proj = toH.dot(segDir);
      if (proj >= 0 && proj <= segLen && from.clone().addScaledVector(segDir, proj).distanceTo(headC) < 0.32) {
        spawnShards(headC, INK.RED, 4, 3);
        cb.onHitmarker(false, true);
        cb.onNetHit?.(a.id, b.dmg * b.headMul, true);
        return true;
      }
      const c: Collider = {
        minX: a.pos.x - 0.4, maxX: a.pos.x + 0.4,
        minY: a.pos.y, maxY: a.pos.y + 1.75,
        minZ: a.pos.z - 0.4, maxZ: a.pos.z + 0.4,
      };
      if (rayAABB(from, segDir, c, segLen) >= 0) {
        spawnShards(a.pos.clone().add(new THREE.Vector3(0, 1.1, 0)), INK.RED, 3, 2);
        cb.onHitmarker(false, false);
        cb.onNetHit?.(a.id, b.dmg, false);
        return true;
      }
    }
    return false;
  }

  /** blasts (grenades) reach the other players as well as us */
  function blastRemotes(pos: THREE.Vector3, radius: number, dmg: number) {
    if (!pvp.active) return;
    for (const a of pvp.remotes.values()) {
      if (!a.state.alive) continue;
      const d = a.pos.distanceTo(pos);
      if (d >= radius) continue;
      cb.onNetHit?.(a.id, dmg * Math.sqrt(Math.max(0, 1 - d / radius)) * 1.5, false);
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
    let pathTries = 0;
    for (let i = 0; i < 26; i++) {
      const a = rand(0, Math.PI * 2);
      const r = rand(minD, maxD);
      const x = clamp(center.x + Math.cos(a) * r, world.bounds.minX, world.bounds.maxX);
      const z = clamp(center.z + Math.sin(a) * r, world.bounds.minZ, world.bounds.maxZ);
      if (!navOpen(x, z) || pointInSolid(x, 0.2, z, 0.7)) continue;
      const p = new THREE.Vector3(x, 0.2, z);
      if (needPath) {
        // Only a couple of candidates are ever path-checked: a search that
        // cannot reach the player explores the whole grid, and 26 of those in
        // one frame is a stall, not a spawn.
        if (pathTries++ >= 2) break;
        if (!navFindPath(p, center.clone().setY(0.2))) continue;
      }
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
    // bounded: a hopeless search gives up and the enemy presses on instead of
    // stalling the frame while it hunts for a route that is not there
    while (heap.length && guard++ < 2500) {
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
    // PAPER WASP: orbit → dive → recover; a katana block knocks it out of the sky.
    e.aimAmt = smooth(e.aimAmt, e.los && dist < 18 ? 1 : 0, 6, dt);
    e.flyT -= dt;
    if (e.flyState === "stunned") {
      e.vel.y -= 20 * dt;
      if (e.onGround || e.flyT <= -1.2) {
        e.flyState = "orbit";
        e.flyT = 0.8;
        e.cooldown = rand(e.def.cool[0], e.def.cool[1]);
      }
      e.yawT = Math.atan2(e.vel.x, e.vel.z);
      return;
    }
    if (e.flyState === "dive") {
      const aim = eyePos();
      const to = aim.clone().sub(e.pos);
      const len = to.length();
      if (len > 0.2) e.vel.lerp(to.divideScalar(len).multiplyScalar(16), Math.min(1, dt * 6));
      // Strike on contact, then break off at once. The old code kept steering
      // into the player for a full second *after* the hit, which parked the wasp
      // on the player's head and made movement feel broken from the knockback.
      if (!e.diveHit && e.pos.distanceTo(aim) < 1.9) {
        e.diveHit = true;
        const dir = aim.clone().sub(e.pos);
        if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
        dir.normalize();
        if (blocking) {
          e.flyState = "stunned";
          e.flyT = 0;
          e.vel.set(dir.x * -4, 2, dir.z * -4);
          fx.katana();
        } else {
          if (player.alive) damagePlayer(e.def.dmg * modDmg, dir);
          // peel off hard and go straight back to the standoff ring
          e.vel.copy(dir).multiplyScalar(-11);
          e.vel.y = Math.max(e.vel.y, 5);
          e.flyState = "orbit";
          e.flyT = 0.9;
          e.cooldown = rand(e.def.cool[0], e.def.cool[1]);
        }
      } else if (e.flyT <= 0) {
        // its dive window closed without connecting: climb away and try again
        e.flyState = "orbit";
        e.flyT = 0.8;
        e.cooldown = rand(1.2, 2.2);
      }
      e.yawT = Math.atan2(e.vel.x, e.vel.z);
      return;
    }
    // orbit in, then commit to the dive
    const orbit = Math.atan2(e.pos.x - player.pos.x, e.pos.z - player.pos.z) + e.strafeDir * 0.5;
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
    // never settle on top of the player: inside the ring it is pushed back out
    const hx = e.pos.x - player.pos.x;
    const hz = e.pos.z - player.pos.z;
    const hd = Math.hypot(hx, hz);
    if (hd < 6) {
      const out = ((6 - hd) / Math.max(0.001, hd)) * 6 * dt;
      e.vel.x += hx * out;
      e.vel.z += hz * out;
      if (hd < 2.5) {
        e.vel.x += hx * 3;
        e.vel.z += hz * 3;
      }
    }
    e.yawT = Math.atan2(e.vel.x, e.vel.z);
    if (e.flyT <= 0 && e.cooldown <= 0 && e.los && dist < 20) {
      e.flyState = "dive";
      e.flyT = 1.5;
      e.diveHit = false;
    }
  }


  const smooth = (cur: number, to: number, k: number, dt: number) => cur + (to - cur) * (1 - Math.exp(-k * dt));
  const blankAtk = (kind: BossAtk["kind"]): BossAtk => ({ kind, t: 0, done: false, dir: null, hit: false, shots: 0 });

  // bosses hurt the crowd around them too, like the reference
  function blastEnemies(pos: THREE.Vector3, radius: number, dmg: number, src: Enemy) {
    for (const o of enemies) {
      if (!o.alive || o === src) continue;
      const d = o.pos.distanceTo(pos);
      if (d >= radius) continue;
      damageEnemy(o, dmg * Math.sqrt(Math.max(0, 1 - d / radius)), false, "blast");
    }
  }

  function spawnAt(kind: EnemyKind, pos: THREE.Vector3): Enemy {
    const m = spawnEnemy(kind);
    m.pos.copy(pos);
    m.root.position.copy(pos);
    m.root.scale.setScalar(ED[kind].scale);
    m.state = "hunt";
    m.t = 0.6;
    return m;
  }

  // shared shockwave: effects, player damage inside the radius, crowd damage around it
  function stompBlast(e: Enemy, radius: number, dmgMul: number, ink: InkId, shards: number) {
    fx.explosion();
    shakeT = Math.max(shakeT, 0.7);
    spawnShards(e.pos.clone().add(new THREE.Vector3(0, 0.25, 0)), ink, shards, 12);
    const dx = player.pos.x - e.pos.x;
    const dz = player.pos.z - e.pos.z;
    const pd = Math.hypot(dx, dz);
    if (player.alive && pd < radius && player.pos.y < e.pos.y + 2.5) {
      const inv = 1 / Math.max(1e-3, pd);
      damagePlayer(e.def.dmg * dmgMul * modDmg, new THREE.Vector3(dx * inv, 0.2, dz * inv));
    }
    blastEnemies(e.pos, radius * 0.8, 60, e);
  }

  /* ---- boss brains, ported from the reference ---- */

  function thinkBoss(e: Enemy, dt: number, dx: number, dz: number, dist: number, dy: number, target: THREE.Vector3) {
    const kind = e.def.bossKind ?? "doodler";
    if (kind === "eraser") return thinkEraser(e, dt, dx, dz, dist, dy, target);
    if (kind === "inkblot") return thinkInkblot(e, dt, dx, dz, dist, dy, target);
    // THE DOODLER — shockwave stomp up close, hurled ink glob at range
    const def = e.def;
    const g = Math.atan2(dx, dz);
    const atk = e.bossAtk;
    if (atk) {
      atk.t += dt;
      e.yawT = g;
      e.vel.x *= Math.max(0, 1 - 5 * dt);
      e.vel.z *= Math.max(0, 1 - 5 * dt);
      if (atk.kind === "stomp") {
        if (atk.t > 0.75 && !atk.done) {
          atk.done = true;
          stompBlast(e, 7.5, 1, INK.BLACK, 24);
        }
        if (atk.t > 1.3) {
          e.bossAtk = null;
          e.cooldown = rand(def.cool[0], def.cool[1]);
        }
      } else {
        if (atk.t > 0.6 && !atk.done) {
          atk.done = true;
          const from = e.pos.clone().add(new THREE.Vector3(0, 1.55 * def.scale + 1, 0));
          const dir = target.clone().add(new THREE.Vector3(0, 1, 0)).sub(from);
          const len = Math.max(1e-3, dir.length());
          dir.divideScalar(len);
          dir.y += len * 0.012;
          dir.normalize();
          spawnBullet(from, dir.multiplyScalar(24), def.dmg * 0.9 * modDmg, false, INK.BLACK, "enemy");
          fx.enemyShot();
        }
        if (atk.t > 1) {
          e.bossAtk = null;
          e.cooldown = rand(def.cool[0] * 0.6, def.cool[1] * 0.6);
        }
      }
      return;
    }
    e.aimAmt = smooth(e.aimAmt, e.los ? 1 : 0, 6, dt);
    if (e.cooldown <= 0 && e.los) {
      if (dist < 7 && Math.abs(dy) < 3) {
        e.bossAtk = blankAtk("stomp");
        fx.bossRoar();
        return;
      }
      if (dist < def.range) {
        e.bossAtk = blankAtk("throw");
        return;
      }
    }
    if (e.los && dist < 14 && Math.abs(dy) < 2) steer(e, dt, target.x, target.z, def.speed, 30);
    else follow(e, dt, target, def.speed);
    if (e.los) e.yawT = g;
  }

  function thinkEraser(e: Enemy, dt: number, dx: number, dz: number, dist: number, dy: number, target: THREE.Vector3) {
    const def = e.def;
    const g = Math.atan2(dx, dz);
    e.aimAmt = smooth(e.aimAmt, 0, 6, dt);
    const atk = e.bossAtk;
    if (atk) {
      atk.t += dt;
      if (atk.kind === "charge") {
        if (atk.t < 0.7) {
          e.yawT = g;
          e.vel.x *= Math.max(0, 1 - 8 * dt);
          e.vel.z *= Math.max(0, 1 - 8 * dt);
          if (atk.t > 0.55 && !atk.dir) {
            atk.dir = new THREE.Vector3(dx, 0, dz).normalize();
            fx.bossRoar();
          }
        } else if (atk.t < 1.9) {
          const dir = atk.dir;
          if (dir) {
            e.vel.x = dir.x * 17 * modSpeed;
            e.vel.z = dir.z * 17 * modSpeed;
          }
          if (dist < 2.6 && Math.abs(dy) < 3 && !atk.hit) {
            atk.hit = true;
            const inv = 1 / Math.max(1e-3, dist);
            damagePlayer(def.dmg * modDmg, new THREE.Vector3(dx * inv, 0.2, dz * inv));
            shakeT = Math.max(shakeT, 0.5);
          }
          if (e.hitWall) {
            atk.t = 1.9;
            spawnShards(e.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), INK.PINK, 30, 9);
            fx.explosion();
            shakeT = Math.max(shakeT, 0.6);
          }
          // pink streaks trail the whole charge
          if (Math.floor(atk.t * 10) !== Math.floor((atk.t - dt) * 10)) {
            spawnShards(e.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), INK.PINK, 4, 3);
          }
        } else {
          e.vel.x *= Math.max(0, 1 - 4 * dt);
          e.vel.z *= Math.max(0, 1 - 4 * dt);
          if (atk.t > 2.7) {
            e.bossAtk = null;
            e.cooldown = rand(def.cool[0], def.cool[1]);
            e.bossCharges++;
          }
        }
      } else {
        // "rub": grind out two ink bombs, then slam ink on everything close
        e.yawT = g;
        e.vel.x *= Math.max(0, 1 - 6 * dt);
        e.vel.z *= Math.max(0, 1 - 6 * dt);
        if (atk.t > 0.9 && !atk.done) {
          atk.done = true;
          stompBlast(e, 6.5, 0.8, INK.PINK, 20);
          const bombs = enemies.filter((o) => o.alive && o.kind === "bomber").length;
          for (let i = 0; i < 2 && bombs + i < 4; i++) {
            const a = rand(0, Math.PI * 2);
            spawnAt("bomber", e.pos.clone().add(new THREE.Vector3(Math.cos(a) * 3, 0.2, Math.sin(a) * 3)));
          }
        }
        if (atk.t > 1.6) {
          e.bossAtk = null;
          e.cooldown = rand(def.cool[0], def.cool[1]);
        }
      }
      return;
    }
    if (e.cooldown <= 0 && e.los) {
      if (e.bossCharges % 3 === 2 && dist < 12) {
        e.bossAtk = blankAtk("rub");
        e.bossCharges++;
        return;
      }
      if (dist < def.range && dist > 3) {
        e.bossAtk = blankAtk("charge");
        return;
      }
    }
    if (e.los && dist < 16 && Math.abs(dy) < 2) steer(e, dt, target.x, target.z, def.speed, 30);
    else follow(e, dt, target, def.speed);
    if (e.los) e.yawT = g;
  }

  function thinkInkblot(e: Enemy, dt: number, dx: number, dz: number, dist: number, dy: number, target: THREE.Vector3) {
    const def = e.def;
    const g = Math.atan2(dx, dz);
    e.aimAmt = smooth(e.aimAmt, e.los ? 1 : 0, 6, dt);
    const atk = e.bossAtk;
    if (atk) {
      atk.t += dt;
      e.yawT = g;
      e.vel.x *= Math.max(0, 1 - 6 * dt);
      e.vel.z *= Math.max(0, 1 - 6 * dt);
      if (atk.kind === "spray") {
        if (atk.t > 0.6 && atk.shots < 9 && atk.t > 0.6 + atk.shots * 0.09) {
          const from = e.pos.clone().add(new THREE.Vector3(0, 1.7 * def.scale, 0));
          const a = Math.atan2(dx, dz) + (atk.shots - 4) * 0.19;
          const dir = new THREE.Vector3(Math.sin(a), 0.18 + rand(-0.05, 0.05), Math.cos(a)).normalize();
          spawnBullet(from, dir.multiplyScalar(20), def.dmg * 0.55 * modDmg, false, INK.BLACK, "enemy");
          atk.shots++;
          if (atk.shots === 1) fx.enemyShot();
        }
        if (atk.t > 1.8) {
          e.bossAtk = null;
          e.cooldown = rand(def.cool[0], def.cool[1]);
          e.bossSprays++;
        }
      } else {
        if (atk.t > 0.8 && !atk.done) {
          atk.done = true;
          fx.bossRoar();
          spawnShards(e.pos.clone().add(new THREE.Vector3(0, 1, 0)), INK.BLACK, 40, 10);
          const flies = enemies.filter((o) => o.alive && o.kind === "flyer").length;
          for (let i = 0; i < 3 && flies + i < 6; i++) {
            spawnAt("flyer", e.pos.clone().add(new THREE.Vector3(rand(-2, 2), 2 + i, rand(-2, 2))));
          }
        }
        if (atk.t > 1.4) {
          e.bossAtk = null;
          e.cooldown = rand(def.cool[0], def.cool[1]);
        }
      }
      return;
    }
    // hop toward you — the blot travels in arcs, and the landing is a shockwave
    e.hopT -= dt;
    if (e.onGround && e.hopT <= 0 && dist > 4) {
      e.hopT = rand(1.6, 2.4);
      const inv = 1 / Math.max(1e-3, dist);
      e.vel.set(dx * inv * 11, 13, dz * inv * 11);
      e.onGround = false;
      e.hopping = true;
    }
    if (e.hopping && e.onGround) {
      e.hopping = false;
      stompBlast(e, 4.5, 0.7, INK.BLACK, 18);
    }
    if (e.cooldown <= 0 && e.los) {
      if (e.bossSprays % 3 === 2) {
        e.bossAtk = blankAtk("summon");
        e.bossSprays++;
        return;
      }
      if (dist < def.range) {
        e.bossAtk = blankAtk("spray");
        return;
      }
    }
    if (!e.hopping) {
      if (e.los && dist < 14 && Math.abs(dy) < 2) steer(e, dt, target.x, target.z, def.speed, 30);
      else follow(e, dt, target, def.speed);
    }
    if (e.los) e.yawT = g;
  }

  function updateEnemy(e: Enemy, dt: number) {
    e.t += dt;
    if (!e.alive) {
      e.dying -= dt;
      e.torso.rotation.x = Math.min(1.5, e.torso.rotation.x + dt * 6);
      e.root.position.y -= dt * 1.2;
      for (const j of [e.legL, e.legR, e.armL, e.armR, e.shinL, e.shinR]) {
        j.rotation.x += (rand(-0.6, 0.6) - j.rotation.x) * dt * 2.5;
      }
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
      e.pos.y = clamp(e.pos.y, e.flyState === "stunned" ? 0.4 : 1.6, 15);
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
    } else if (e.def.weapon === "boss") {
      thinkBoss(e, dt, dx, dz, dist, dy, target);
    } else if (e.def.weapon === "blade") {
      updateRusher(e, dt, dx, dz, dist, dy, target);
    } else {
      updateRanged(e, dt, dx, dz, dist, dy, target);
    }

    // If this one has been walled away from the player — no route, no sight line,
    // far away — drop it back onto open ground rather than stall the wave.
    e.pathFailT = e.path && e.pathI < e.path.length ? 0 : e.pathFailT + dt;
    if (e.pathFailT > 7 && dist > 26 && !e.los) {
      if (e.valveT > 0) e.valveT -= dt;
      const spot = e.valveT <= 0 ? findOpenSpot(player.pos, 20, 34, true) : null;
      if (!spot) {
        // no room found: back off hard instead of re-searching every frame
        e.valveT = 4;
      } else {
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

    animateRig(e, dt, dist, dy);
  }

  // Walk cycle with real joints: hips and shoulders swing, knees only bend
  // backwards and elbows forward, and the weapon arm rises to aim. Weight shift
  // comes from a small hip roll and a torso counter-rotation.
  function animateRig(e: Enemy, dt: number, dist: number, dy: number) {
    const spd = Math.hypot(e.vel.x, e.vel.z);
    // blobs and the wasp have no skeleton to pose: a wobble and a few wiggling
    // limbs read better than a walk cycle on a body with no knees.
    if (e.def.model) {
      const w = Math.sin(e.t * (e.def.model === "flyer" ? 16 : 7));
      if (e.def.model !== "flyer") {
        e.legL.rotation.x = w * 0.55;
        e.legR.rotation.x = -w * 0.55;
        e.armL.rotation.x = -w * 0.45;
        e.armR.rotation.x = w * 0.45;
      }
      e.torso.rotation.z = w * 0.09;
      e.torso.position.y = Math.abs(w) * 0.03;
      return;
    }
    const gait = clamp(spd / 6.5, 0, 1);
    const ph = e.t * (5.5 + spd * 0.75);
    const amp = 0.12 + gait * 0.62;
    const sw = Math.sin(ph);
    const swB = Math.sin(ph + Math.PI);

    e.legL.rotation.x = -sw * amp;
    e.legR.rotation.x = -swB * amp;
    e.shinL.rotation.x = Math.max(0, Math.sin(ph - 1.1)) * amp * 1.25;
    e.shinR.rotation.x = Math.max(0, Math.sin(ph + Math.PI - 1.1)) * amp * 1.25;

    // arms: the left swings, the right rides the weapon
    e.armL.rotation.x = swB * amp * 0.7 - 0.05;
    e.foreL.rotation.x = -0.25 - Math.max(0, swB) * 0.35;
    const aim = e.aimAmt ?? 0;
    if (e.def.boss) {
      // bosses telegraph: the arm winds up, then slams (the reference's pose maths)
      const atk = e.bossAtk;
      const wind = atk && (atk.kind === "stomp" || atk.kind === "throw") ? clamp(atk.t / (atk.kind === "stomp" ? 0.6 : 0.5), 0, 1) : 0;
      const slam = atk && atk.kind === "stomp" && atk.t >= 0.75 ? 1 : 0;
      const charge = atk && atk.kind === "charge" ? 1 : 0;
      e.armR.rotation.x += (-0.4 - sw * amp * 0.5 - wind * 2.4 + slam * 0.9 - e.armR.rotation.x) * (1 - Math.exp(-10 * dt));
      e.armR.rotation.z = -0.2 - wind * 0.2;
      e.foreR.rotation.x = -1.1 + wind * 0.3 + slam * 0.7;
      e.armL.rotation.x = swB * amp * 0.5 - wind * 1.1 + slam * 0.4;
      e.foreL.rotation.x = -0.3 - wind * 0.4;
      e.torso.rotation.x = -wind * 0.28 + slam * 0.4 + charge * 0.5;
    } else if (e.def.weapon === "blade") {
      e.armR.rotation.x = -0.4 - sw * amp * 0.5;
      e.foreR.rotation.x = -1.15 - (e.attackT > 0 ? 0.5 : 0);
      e.armR.rotation.z = -0.35;
    } else {
      const raised = e.def.weapon === "bomb" ? -0.2 : -1.35 - aim * 0.25;
      e.armR.rotation.x += (raised - e.armR.rotation.x) * (1 - Math.exp(-7 * dt));
      e.armR.rotation.z = 0;
      e.foreR.rotation.x = -0.35 + swB * amp * 0.15;
    }

    // weight shift and head tracking
    e.hips.rotation.z = Math.sin(ph * 0.5) * 0.06 * gait;
    e.torso.rotation.y = -sw * 0.1 * gait;
    e.torso.position.y = Math.abs(Math.sin(ph)) * 0.025 * gait;
    if (e.alive) {
      const wantPitch = clamp(-Math.atan2(dy, Math.max(1, dist)) * 0.8, -0.45, 0.45);
      e.head.rotation.x += (wantPitch - e.head.rotation.x) * (1 - Math.exp(-6 * dt));
      e.head.rotation.y = Math.sin(e.t * 0.7) * 0.06 * (1 - gait);
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
    player.grenades = Math.min(player.maxGrenades, player.grenades + 1);
    spawnPickups();
    pushHud();
  }

  /** An online deathmatch: no waves, no enemies — only the other players. */
  function startMatch() {
    wave = 0;
    modifierName = "FREE FOR ALL";
    enemiesLeft = 0;
    queue = [];
    comboCount = 0;
    spawnPickups();
    cb.onMessage("FREE FOR ALL", "shoot the other doodle first", 2.6);
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
      const box = new THREE.Mesh(pickupGeo, m);
      g.add(box);
      if (kind === "health") {
        const bar = new THREE.Mesh(pickupBarGeo, m);
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
    const mesh = new THREE.Mesh(nadeGeo, makeInkMaterial(INK.BLACK, true));
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
    netFireT = Math.max(0, netFireT - dt);
    // Online, down and waiting for the respawn: hold the death pose and take no
    // input at all until the net layer calls netRespawn(). Solo never gets here
    // (a death ends the run and step() stops calling this).
    if (pvp.active && !p.alive) {
      p.vel.set(0, 0, 0);
      netMoving = false;
      camera.rotation.order = "YXZ";
      camera.rotation.y = p.yaw;
      camera.rotation.x = p.pitch;
      camera.rotation.z = 0;
      return;
    }
    p.crouch = keys.has("ControlLeft") || keys.has("KeyC");
    p.sprint = keys.has("ShiftLeft") || keys.has("ShiftRight");
    // Standing back up must respect headroom: expanding the body inside a
    // crawlspace jams the resolver. Stay crouched until there is room.
    const wantHeight = p.crouch ? JN : CI;
    if (wantHeight > p.height) {
      let blocked = false;
      for (const c of world.colliders) {
        if (
          p.pos.x + p.radius > c.minX &&
          p.pos.x - p.radius < c.maxX &&
          p.pos.z + p.radius > c.minZ &&
          p.pos.z - p.radius < c.maxZ &&
          p.pos.y + CI > c.minY &&
          p.pos.y < c.minY
        ) {
          blocked = true;
          break;
        }
      }
      if (!blocked) p.height = wantHeight;
    } else {
      p.height = wantHeight;
    }

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
    netMoving = moving;
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

      // world — sub-stepped so fast rounds cannot tunnel through a thin
      // wall or floor plank between frames (one ray per ~2m slice).
      const dir = step.clone();
      const len = dir.length();
      if (len > 1e-6) {
        dir.divideScalar(len);
        const slices = Math.max(1, Math.ceil(len / 2));
        const sliceLen = len / slices;
        for (let s = 0; s < slices && !dead; s++) {
          const base = from.clone().addScaledVector(dir, s * sliceLen);
          const t = rayAABBall(base, dir, sliceLen);
          if (t >= 0) {
            dead = true;
            spawnShards(base.clone().addScaledVector(dir, t), b.ink, 2, 1.6);
          }
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
          // online: the other players are targets too
          if (!dead && hitRemoteSegment(from, to, b)) dead = true;
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
        damageEnemy(e, b.dmg * b.headMul, true, b.source);
        return true;
      }
    }
    // body AABB
    const c: Collider = { minX: e.pos.x - 0.5 * s, maxX: e.pos.x + 0.5 * s, minY: e.pos.y, maxY: e.pos.y + 1.85 * s, minZ: e.pos.z - 0.35 * s, maxZ: e.pos.z + 0.35 * s };
    const t = rayAABB(from, segDir, c, segLen);
    if (t >= 0) {
      damageEnemy(e, b.dmg, false, b.source);
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
      // online: the other players show up on the map too
      for (const a of pvp.remotes.values()) {
        if (!a.state.alive) continue;
        const dx = a.pos.x - player.pos.x;
        const dz = a.pos.z - player.pos.z;
        const fwd = dx * -sy + dz * -cy;
        const right = dx * cy - dz * sy;
        blips.push({ x: clamp(right / 62, -1, 1), z: clamp(-fwd / 62, -1, 1), boss: false });
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
      releaseRig(e.root);
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
    const bestKey = "dd_best";
    const prev = Number(localStorage.getItem(bestKey) || 0);
    const isBest = score > prev;
    if (isBest) localStorage.setItem(bestKey, String(score));
    const prevWave = Number(localStorage.getItem("dd_best_wave") || 0);
    if (wave > prevWave) localStorage.setItem("dd_best_wave", String(wave));
    fx.wave();
    cb.onBoss(null, 0);
    cb.onGameOver({ wave, kills, score, best: isBest });
    releasePointer();
  }

  function step(dtRaw: number) {
    const t = performance.now() * 0.001;
    postMat.uniforms.uTime.value = t;

    if (state !== "playing") {
      // The cursor is only hidden while the pointer is captured, so a menu,
      // pause or game-over screen must always hand the mouse back.
      if (document.pointerLockElement) releasePointer();
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
    steerFromEdge(dt);
    if (hitstopT > 0) dt *= 0.2;

    updatePlayer(dtRaw);
    // A non-finite position is unrecoverable: the camera matrix goes NaN and
    // the scene stops drawing entirely. Recover instead of freezing.
    if (!Number.isFinite(player.pos.x + player.pos.y + player.pos.z)) {
      player.pos.set(0, 0.2, 38);
      player.vel.set(0, 0, 0);
    }
    // Fell out of the world (through a seam, off the arena rim): back to the
    // start point instead of being stranded under the map forever. Enemies
    // already have this net; the player deserved the same.
    if (player.pos.y < -6) {
      player.pos.set(0, 0.2, 38);
      player.vel.set(0, 0, 0);
    }
    for (const e of enemies) updateEnemy(e, dt);
    separateEnemies(dt);
    // cull fully-dead
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (!enemies[i].alive && enemies[i].dying <= -0.1) {
        dropLaser(enemies[i]);
        releaseRig(enemies[i].root);
        enemies.splice(i, 1);
      }
    }
    updateBullets(dt);
    updateGrenades(dt);
    updateShards(dtRaw);
    updatePickups(dt);

    // wave spawner — an online deathmatch has no waves at all, so the slot is
    // used to drive the other players instead
    if (pvp.active) {
      updateRemoteActors(dt);
    } else if (queue.length > 0) {
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
  let stepFaulted = false;
  const loop = () => {
    // scheduled first, so the picture keeps coming even if a frame throws
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    try {
      district.update(now * 0.001);
      step(dt);
    } catch (err) {
      // One bad frame used to stop the world mid-wave (a frozen wasp and a
      // screen that no longer drew). Report it once instead of freezing.
      if (!stepFaulted) {
        stepFaulted = true;
        console.error("[doodle district] frame error", err);
      }
    }
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
    // Online, while our player is down: only pausing (and the music toggle)
    // still answers — no reloading, throwing or weapon swaps from the grave.
    if (pvp.active && !player.alive && code !== "Escape" && code !== "KeyP" && code !== "KeyM") return;
    if (state !== "playing") {
      if (code === "KeyM") {
        fx.musicOn = !fx.musicOn;
      }
      // Esc/P while paused goes straight back into the run - pause is always
      // one keypress from the game, in either direction.
      if ((code === "Escape" || code === "KeyP") && state === "paused") {
        handleRef.current.resume();
      }
      return;
    }
    keys.add(code);
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
    if (pvp.active && !player.alive) return;
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
    pointerInside = true;
    cursorX = e.clientX;
    cursorY = e.clientY;
    cursorSeen = true;
    lastLookMoveMs = performance.now();
    // cursor-position deltas, kept as a fallback look input
    const cdx = e.clientX - lastCX;
    const cdy = e.clientY - lastCY;
    lastCX = e.clientX;
    lastCY = e.clientY;
    if (state !== "playing") return;
    // Moving the mouse turns the view. That is the whole look system: it does
    // not wait on — and is not gated by — whether the browser granted a pointer
    // capture, because a restricted frame can refuse that outright.
    // the reference's own sensitivity: 0.0022 rad per mouse count at 100%
    const s = (0.0022 * sensitivity) / 100;
    // its spike guard too: a single wild delta (a device switch, a glitch) is
    // dropped rather than snapping the view
    let dx = e.movementX;
    let dy = e.movementY;
    // Real flicks on a 1000 Hz mouse deliver several hundred counts in one
    // coalesced frame; the old 400 cap ate them as "spikes" and the view
    // stuttered exactly when flicking. 1500 is far above honest motion and
    // still drops device glitches.
    if (Math.abs(dx) > 1500) dx = 0;
    if (Math.abs(dy) > 1500) dy = 0;
    // Dead-capture detector: while captured, an honest device always reports
    // motion on a mousemove. A streak of silent events means this capture is
    // delivering no data at all - exactly the "mouse frozen until Esc" state -
    // so the engine drops it itself and the working unlocked path takes over
    // the same frame. On normal machines this never fires; a capture that
    // reports real motion resets the streak to zero forever.
    if (isLocked()) {
      if (dx !== 0 || dy !== 0) lockedZeroStreak = 0;
      else if (++lockedZeroStreak >= 8) {
        lockedZeroStreak = 0;
        releasePointer();
      }
    }
    // Some restricted frames deliver unlocked mouse events with movement deltas
    // of exactly 0, so the view would never turn. Cursor-position deltas are
    // the same motion; use them whenever the movement ones are silent.
    if (dx === 0 && dy === 0 && (cdx !== 0 || cdy !== 0) && !isLocked()) {
      dx = Math.abs(cdx) > 1500 ? 0 : cdx;
      dy = Math.abs(cdy) > 1500 ? 0 : cdy;
    }
    player.yaw -= dx * s;
    player.pitch -= dy * s * (invertY ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.5, 1.5);
  };
  const onWheel = (e: WheelEvent) => {
    if (state !== "playing") return;
    e.preventDefault();
    switchSlot((curSlot + (e.deltaY > 0 ? 1 : slots.length - 1)) % slots.length);
  };
  // Pointer capture is asked for on every click and key press, because that is
  // the only time a browser will grant it. Nothing in the game waits on it: if
  // it is refused (a restricted frame cannot take the pointer at all) the run
  // plays exactly the same, with the cursor visible.
  const isLocked = () => document.pointerLockElement != null;
  const requestLock = () => {
    if (disposed || state !== "playing" || isLocked()) return;
    if (performance.now() < lockCooldownUntil) return;
    // A remount (StrictMode) can leave this canvas out of the document:
    // requesting the pointer on it throws WrongDocumentError.
    if (!canvas.isConnected) return;
    const refuse = () => {
      if (disposed || performance.now() < lockCooldownUntil) return;
      lockCooldownUntil = performance.now() + 1500;
      // Silent by design: a refused capture must never surface as a popup —
      // the unlocked look fallback takes over invisibly.
    };
    // Must be invoked *on* the canvas: calling it detached throws
    // "Illegal invocation", which silently killed every request.
    // Plain pointer lock only — same call the reference game makes. The
    // unadjustedMovement (raw) form is what broke real browsers: Chromium
    // grants it, then some devices deliver no motion data at all, so the view
    // froze while the game kept running. OS-level acceleration belongs to the
    // player's system settings, exactly as on the reference site.
    const request = canvas.requestPointerLock.bind(canvas) as () =>
      Promise<void> | void;
    try {
      const p = request();
      if (p && typeof p.catch === "function") p.catch(refuse);
    } catch {
      refuse();
    }
  };
  /** Hand the mouse back: every menu, pause and game-over screen does this. */
  const releasePointer = () => {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* never let a pointer-lock quirk break pause / menu / game over */
    }
  };
  /**
   * Lock-free edge steering, for the restricted preview frames that cannot take
   * the pointer at all. The cursor must be deliberately HELD against a screen
   * edge before any auto-turn starts: a thin 18px band, a 0.25 s park, and a
   * gentle ramp to a slow rate keep normal aiming — sweeping the cursor across
   * the frame, resting it mid-screen, even brushing an edge — completely free
   * of rotation. Any real mouse input (movement deltas, a capture) or a
   * pointer that leaves the window stops it at once.
   */
  const steerFromEdge = (dt: number) => {
    // Only ever a fallback: with the pointer captured — every real browser —
    // mouse deltas alone drive look, exactly like the reference.
    if (isLocked() || !cursorSeen || !pointerInside) return;
    // The mouse moved this beat, so the player is aiming: never auto-turn.
    // (Unrestricted frames report movement deltas; stripped-delta frames still
    // reach here on cursor motion, so also watch cursor-position deltas.)
    const still = performance.now() - lastLookMoveMs > 250;
    if (!still) {
      edgeParkT = 0;
      return;
    }
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    // A thin band at the frame edge. ~18px means the cursor must be pressed
    // right up against the edge — resting aim anywhere else on screen never
    // enters the band, which is what fixes the runaway spin during normal aim.
    const margin = 18;
    // Gentle on purpose: this is an escape hatch for frames with no pointer
    // capture, not a second look system. Slow even at full depth.
    const rate = 1.0; // rad/s at the very edge
    const depth = (v: number, span: number) =>
      v < margin
        ? -(margin - v) / margin
        : v > span - margin
          ? (v - (span - margin)) / margin
          : 0;
    const ex = depth(cursorX, w);
    const ey = depth(cursorY, h);
    if (!ex && !ey) {
      edgeParkT = 0;
      return;
    }
    // Hold the cursor in the band for a beat first: sweeping past an edge, or
    // any live aim that clips it, parks for 0 ms and never auto-turns.
    edgeParkT += dt;
    if (edgeParkT < 0.25) return;
    // Ease in over ~0.6 s so the turn starts as a nudge, not a jump.
    const ramp = Math.min(1, (edgeParkT - 0.25) / 0.6);
    const a = ex * rate * ramp * dt;
    player.yaw -= a;
    player.pitch -= ey * rate * ramp * dt * (invertY ? -1 : 1);
    player.pitch = clamp(player.pitch, -1.5, 1.5);
  };
  const onContext = (e: Event) => e.preventDefault();
  const onLeave = () => {
    pointerInside = false;
  };
  const onOut = (e: MouseEvent) => {
    // relatedTarget is null when the pointer has actually left the window
    if (!e.relatedTarget) onLeave();
  };
  const onPointerLockChange = () => {
    // Capturing or releasing the pointer is not a hitch: restart the clock so
    // the frame that follows is not measured against time spent in the menu.
    last = performance.now();
  };
  // Fired when a request is refused (a restricted frame, a not-yet-permitted
  // re-lock after Escape). Stop asking rather than retrying forever.
  const onPointerLockError = () => {
    lockCooldownUntil = performance.now() + 1500;
  };
  // A capture is only ever granted on a gesture, and the request has to be made
  // from inside it — so every click and key press while a run is live asks,
  // wherever it lands (canvas, HUD, tip). Escape and P are left alone: they
  // open the pause menu, which hands the mouse back.
  const onGesture = (e: Event) => {
    if (e.type === "keydown") {
      const code = (e as KeyboardEvent).code;
      if (code === "Escape" || code === "KeyP") return;
    }
    requestLock();
  };
  const onBlur = () => {
    // Losing focus (or the tab being hidden) only means the held keys and
    // buttons can no longer be trusted: a button released outside the window
    // never reports. It is NOT a reason to pause — an embedded preview frame
    // blurs constantly, and the original only clears the keys here too.
    keys.clear();
    mouseButtons.clear();
    mouseFire = false;
    mouseAim = false;
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("mousemove", onMouseMove);
  document.documentElement.addEventListener("mouseleave", onLeave);
  window.addEventListener("mouseout", onOut);
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onBlur);
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("pointerlockerror", onPointerLockError);
  canvas.addEventListener("contextmenu", onContext);

  /* ---------- public handle ---------- */
  setViewModel(0);
  const handleRef: { current: GameHandle } = { current: null as unknown as GameHandle };
  const handle: GameHandle = {
    start() {
      resetRun();
      state = "playing";
      intermissionT = 3;
      fx.ensure();
      if (pvp.active) startMatch();
      else startWave(1);
      cb.onResume();
      // START is a real click, so this is the one moment a capture can be
      // granted. If it is refused, moving the mouse still looks around.
      requestLock();
    },
    pause() {
      if (state !== "playing") return;
      state = "paused";
      keys.clear();
      mouseFire = false;
      mouseAim = false;
      // Tell React first: a pointer-lock quirk must never leave the player on a
      // frozen game with no overlay and an invisible cursor.
      cb.onPause({ wave, score });
      releasePointer();
    },
    resume() {
      if (state !== "paused") return;
      state = "playing";
      last = performance.now();
      cb.onResume();
      // RESUME is a click as well: take the mouse back now the run is live.
      requestLock();
    },
    restart() {
      resetRun();
      state = "playing";
      cb.onResume();
      if (pvp.active) startMatch();
      else startWave(1);
      requestLock();
    },
    setPvp(on: boolean) {
      pvp.active = on;
      if (!on) {
        for (const a of pvp.remotes.values()) dropRemote(a);
        pvp.remotes.clear();
      }
    },
    netState(): NetPlayerState {
      return {
        x: player.pos.x,
        y: player.pos.y,
        z: player.pos.z,
        yaw: player.yaw,
        pitch: player.pitch,
        hp: Math.ceil(player.hp),
        alive: player.alive,
        moving: netMoving,
        firing: netFireT > 0,
        weapon: slots[curSlot].def.name,
      };
    },
    setRemotePlayers(list: NetRemotePlayer[]) {
      syncRemotePlayers(list);
    },
    takeNetHit(dmg: number, killerId: string) {
      if (!pvp.active) return;
      damagePlayer(dmg, undefined, killerId);
    },
    netRespawn(preferIndex?: number) {
      if (!pvp.active) return;
      // Street level only — a few of the map's spawn pads sit on rooftops, and
      // respawning onto a roof is a fall the player never asked for.
      const ground = district.spawnPoints.filter((s) => s.y <= 0.5);
      const spots = ground.length > 0 ? ground : district.spawnPoints;
      let best = spots[0] ?? new THREE.Vector3(0, 0.2, 38);
      if (typeof preferIndex === "number" && spots.length > 0) {
        // the numbered pad the match handed out: how a fresh match spreads the
        // players across the district instead of stacking them on the start line
        best = spots[((preferIndex % spots.length) + spots.length) % spots.length];
      } else {
        // otherwise the pad nobody is standing near wins
        let bestD = -1;
        for (const s of spots) {
          let d = Infinity;
          for (const a of pvp.remotes.values()) { const v = a.pos.distanceTo(s); if (v < d) d = v; }
          if (d > bestD) {
            bestD = d;
            best = s;
          }
        }
      }
      player.pos.set(best.x, Math.max(0.2, best.y), best.z);
      player.vel.set(0, 0, 0);
      player.hp = player.maxHp;
      player.alive = true;
      player.regenDelay = 0;
      player.hurtFx = 0;
      player.flashFx = 0;
      for (const s of slots) {
        s.mag = s.def.magSize;
        s.reserve = s.def.reserve;
      }
      reloadT = 0;
      fireCd = 0;
      mouseFire = false;
      mouseAim = false;
      pushHud();
    },
    isAlive() {
      return player.alive;
    },
    toMenu() {
      resetRun();
      state = "menu";
      cb.onBoss(null, 0);
      cb.onResume();
      releasePointer();
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
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("mouseout", onOut);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("pointerlockerror", onPointerLockError);
      releasePointer();
      canvas.removeEventListener("contextmenu", onContext);
      renderer.dispose();
      canvas.remove();
    },
  };
  handleRef.current = handle;
  loop();
  return handle;
}
