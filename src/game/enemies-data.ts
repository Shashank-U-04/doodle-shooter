// Original-tuned data tables: enemies, waves, modifiers, movement constants.

import { INK, type InkId } from "./world";

/* movement constants transcribed from the original */
export const PR = 6.6; // walk speed
export const QR = 10.6; // sprint speed
export const VR = 3.6; // crouch speed
export const DR = 140; // ground accel
export const NR = 8; // ground friction
export const FR = 36; // air accel
export const OR_ = 7.5; // air max speed
export const XN = 9.6; // jump velocity
export const XN_AIR = XN * 0.92; // double jump
export const CI = 1.75; // stand height
export const JN = 1.05; // crouch height
export const EYE = 1.6;
export const BASE_FOV = 82;
export const SENS = 0.0022; // × sensitivity %
export const GRAV = 22;
export const KATANA_STREAK = 3;
export const FOCUS_DUR = 2.6;
export const FOCUS_MAX = 2;

export type EnemyKind = "grunt" | "rusher" | "bomber" | "sniper" | "flyer" | "heavy" | "shield" | "boss" | "eraser" | "inkblot";

export type EnemyDef = {
  hp: number;
  speed: number;
  weapon: string;
  range: number;
  stop: number;
  keep: number;
  burst?: number;
  burstInt?: number;
  pellets?: number;
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
  bodyW: number;
  headS: number;
  limbR: number;
  model?: "blob" | "flyer";
  bossKind?: string;
};

export const ED: Record<EnemyKind, EnemyDef> = {
  grunt: { hp: 100, speed: 5.2, weapon: "rifle", range: 28, stop: 16, keep: 7, burst: 3, burstInt: 0.15, cool: [1.6, 2.6], dmg: 6, score: 100, scale: 1, name: "GRUNT", ink: INK.BLUE, hat: "cap", bodyW: 1, headS: 1, limbR: 0.032 },
  rusher: { hp: 70, speed: 7.6, weapon: "blade", range: 3, stop: 1.9, keep: 0, cool: [1, 1.5], dmg: 15, score: 120, scale: 0.95, name: "RUSHER", ink: INK.RED, hat: "band", bodyW: 0.82, headS: 0.95, limbR: 0.027 },
  bomber: { hp: 26, speed: 6.5, weapon: "bomb", range: 3.4, stop: 0, keep: 0, cool: [1.05, 1.05], dmg: 24, score: 150, scale: 0.9, name: "INK BOMB", ink: INK.BLACK, model: "blob", bodyW: 1, headS: 1, limbR: 0.03 },
  sniper: { hp: 60, speed: 3.6, weapon: "sniper", range: 90, stop: 90, keep: 15, cool: [2.8, 3.8], dmg: 22, score: 180, scale: 1.05, name: "SNIPER", ink: INK.GREEN, hat: "hood", bodyW: 0.78, headS: 0.92, limbR: 0.026 },
  flyer: { hp: 40, speed: 6.2, weapon: "dive", range: 2.2, stop: 0, keep: 0, cool: [2.8, 4.2], dmg: 10, score: 140, scale: 1.5, name: "PAPER WASP", ink: INK.PINK, flying: true, model: "flyer", bodyW: 1, headS: 1, limbR: 0.03 },
  heavy: { hp: 320, speed: 3, weapon: "shotgun", range: 18, stop: 9, keep: 5, pellets: 7, cool: [2.4, 3.2], dmg: 5, score: 260, scale: 1.25, name: "HEAVY", ink: INK.ORANGE, hat: "helmet", bodyW: 1.55, headS: 0.88, limbR: 0.05 },
  shield: { hp: 150, speed: 3.8, weapon: "pistol", range: 20, stop: 8, keep: 4, burst: 2, burstInt: 0.2, cool: [1.8, 2.6], dmg: 5, score: 200, scale: 1.05, name: "SHIELDBEARER", ink: INK.BLUE, shield: true, hat: "helmet", bodyW: 1.2, headS: 0.9, limbR: 0.042 },
  boss: { hp: 2600, speed: 3.2, weapon: "boss", range: 32, stop: 6, keep: 0, cool: [2.6, 3.6], dmg: 22, score: 2500, scale: 2.7, name: "THE DOODLER", ink: INK.BLACK, boss: true, hat: "crown", bodyW: 1.35, headS: 1.15, limbR: 0.06 },
  eraser: { hp: 3400, speed: 4.2, weapon: "boss", range: 30, stop: 8, keep: 0, cool: [2.2, 3.2], dmg: 26, score: 3200, scale: 2.6, name: "THE ERASER", ink: INK.PINK, boss: true, model: "blob", bossKind: "eraser", bodyW: 1, headS: 1, limbR: 0.04 },
  inkblot: { hp: 3000, speed: 3, weapon: "boss", range: 34, stop: 10, keep: 0, cool: [2.4, 3.4], dmg: 20, score: 3600, scale: 2.4, name: "THE INKBLOT", ink: INK.BLACK, boss: true, model: "blob", bossKind: "inkblot", bodyW: 1, headS: 1, limbR: 0.04 },
};

export const SPAWN_TABLE: { t: EnemyKind; from: number; w: number }[] = [
  { t: "grunt", from: 1, w: 10 },
  { t: "rusher", from: 2, w: 6 },
  { t: "bomber", from: 3, w: 3 },
  { t: "sniper", from: 3, w: 4 },
  { t: "flyer", from: 4, w: 4 },
  { t: "heavy", from: 5, w: 4 },
  { t: "shield", from: 6, w: 4 },
];

export const BOSS_CYCLE: EnemyKind[] = ["boss", "eraser", "inkblot"];
export const BOSS_NAMES: Record<string, string> = { boss: "THE DOODLER", eraser: "THE ERASER", inkblot: "THE INKBLOT" };

export const MODIFIERS = [
  { name: "", speed: 1, dmg: 1, extra: 0 },
  { name: "CAFFEINATED · they move fast", speed: 1.35, dmg: 0.85, extra: 0 },
  { name: "HEAVY INK · they hit harder", speed: 0.9, dmg: 1.4, extra: 0 },
  { name: "SWARM · more of them, thinner", speed: 1.15, dmg: 0.9, extra: 3 },
];

export const TIPS = [
  "hold <b>Q</b>/<b>E</b> to reel in · tap again to let go",
  "block with the <b>KATANA</b> — some bullets go back",
  "kills in the air are worth more · stay off the floor",
  "<b>G</b> lobs a grenade · pickups give you more",
  "press <b>Space</b> again in the air for a double jump",
];
