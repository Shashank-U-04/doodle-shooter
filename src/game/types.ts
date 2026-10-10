export type HudState = {
  score: number;
  combo: string;
  wave: number;
  left: number;
  modifier: string;
  hp: number;
  maxHp: number;
  mag: number;
  reserve: number;
  reloading: boolean;
  nades: number;
  weapon: string;
  hint: string;
  slots: string[];
  slot: number;
  focus: number;
  focusOn: boolean;
  /** enemies in the player's own frame: x = right, z = forward, both -1..1 */
  blips: { x: number; z: number; boss: boolean }[];
};

/** The HUD before the first frame is pushed — shared by every game screen. */
export const EMPTY_HUD: HudState = {
  score: 0,
  combo: "",
  wave: 0,
  left: 0,
  modifier: "",
  hp: 120,
  maxHp: 120,
  mag: -1,
  reserve: -1,
  reloading: false,
  nades: 0,
  weapon: "RIFLE",
  hint: "",
  slots: [],
  slot: 0,
  focus: 0,
  focusOn: false,
  blips: [],
};

export type GameOverStats = {
  wave: number;
  kills: number;
  score: number;
  best: boolean;
};

/** ------------------------------------------------------------------ *
 * Online play (PvP)
 *
 * The net layer (src/game/net.ts) keeps the roster and the transport; the
 * engine only knows how to draw remote players and how to trade damage with
 * them. These types are the whole contract between the two.
 * ------------------------------------------------------------------ */

/** One player's transform + vitals, exactly as it goes over the wire. */
export type NetPlayerState = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  hp: number;
  alive: boolean;
  moving: boolean;
  firing: boolean;
  /** weapon name, so a remote's gun reads the same as ours */
  weapon: string;
};

/** A remote player the engine should draw this frame. */
export type NetRemotePlayer = {
  id: string;
  name: string;
  /** ink index (0-5) so every player can be told apart at a glance */
  ink: number;
  state: NetPlayerState;
};

export type EngineCallbacks = {
  onHud: (hud: HudState) => void;
  onMessage: (title: string, sub: string | null, dur: number) => void;
  onTip: (text: string, dur: number) => void;
  onKillFeed: (text: string, hot: boolean) => void;
  onHitmarker: (kill: boolean, crit: boolean) => void;
  onBoss: (name: string | null, frac: number) => void;
  onGameOver: (stats: GameOverStats) => void;
  onPause: (state: { wave: number; score: number }) => void;
  onResume: () => void;
  onAim: (ads: boolean) => void;
  // ---- online only: none of these fire during a solo run ----
  /** our own shot landed on a remote player (dmg is what they should take) */
  onNetHit?: (victimId: string, dmg: number, head: boolean) => void;
  /** we were erased; killerId names the remote that did it (null = self/void) */
  onNetDeath?: (killerId: string | null) => void;
};

export interface GameHandle {
  start(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  toMenu(): void;
  setSensitivity(v: number): void;
  setInvert(on: boolean): void;
  setMusic(on: boolean): void;
  dispose(): void;
  // ---- online play: every one of these is a no-op in a solo run ----
  /** Turn the arena into a free-for-all deathmatch: no waves, no enemies. */
  setPvp(on: boolean): void;
  /** Our own transform + vitals, for the net layer to broadcast. */
  netState(): NetPlayerState;
  /** Authoritative list of remote players to draw (positions are smoothed). */
  setRemotePlayers(players: NetRemotePlayer[]): void;
  /** A remote player's shot landed on us: take it and credit the killer. */
  takeNetHit(dmg: number, killerId: string): void;
  /**
   * Back into the fight after a death (full health).
   * `preferIndex` pins the spawn to a numbered pad — the match uses it to hand
   * everyone a different corner at the start; without it the spawn furthest
   * from the other players wins.
   */
  netRespawn(preferIndex?: number): void;
  /** True while our own player is still standing. */
  isAlive(): boolean;
}
