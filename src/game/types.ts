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
  /** name of the area the player is in, when the map has distinct areas */
  area?: string;
  /** proximity action, e.g. "OPEN THE GREAT STONE DOOR" (Egypt only) */
  prompt?: string;
  /** true underground, where the HUD has to switch off multiply blending */
  dark?: boolean;
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
  area: "",
  prompt: "",
  dark: false,
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
  /**
   * Generation of this body. Bumped every time it is *teleported* (respawn,
   * rematch, a focus dash) rather than walked. Peers snap to a new epoch and
   * refuse anything older, which is what stops the packets still in flight when
   * a player died from dragging their fresh body back to the death spot.
   */
  epoch: number;
  /**
   * Packet counter within one epoch. A transform that arrives out of order (the
   * host relays two guests into one stream, so this happens) would otherwise
   * rewind an avatar by one packet and read as jitter.
   */
  seq: number;
};

/** Where a shot was fired from, so the victim can check it against the world. */
export type NetShotOrigin = { x: number; y: number; z: number };

/**
 * Should an arriving transform replace the one we already hold for a player?
 *
 * Two rules, both about what a star relay actually delivers:
 *
 *  - **older epoch = stale.** A body that has been teleported (respawn,
 *    rematch, focus dash) carries a higher generation. Packets stamped before
 *    that teleport are still in flight and would drag the fresh body back to
 *    where it died — the "respawned into the death spot" bug, seen from the
 *    other end of the wire.
 *  - **older sequence within one epoch = out of order.** Four players relayed
 *    through one host arrive interleaved; applying them in arrival order makes
 *    an avatar hop backwards a packet's worth, which reads as bad hitreg.
 *
 * It lives here, next to the state it guards, so both the transport and any
 * test can ask the same question.
 */
export function shouldApplyState(prev: NetPlayerState | undefined, next: NetPlayerState): boolean {
  if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.z) || !Number.isFinite(next.hp)) {
    return false;
  }
  if (!prev) return true;
  const pe = prev.epoch ?? 0;
  const ne = next.epoch ?? 0;
  if (ne < pe) return false;
  if (ne === pe && (next.seq ?? 0) <= (prev.seq ?? 0)) return false;
  return true;
}

/**
 * One shot that the shooter watched land on another player.
 *
 * A struct rather than a parameter list on purpose: this crosses three files
 * (engine → page → net → victim) and every field matters, so the compiler should
 * be the thing that stops a caller from swapping the damage and the epoch.
 */
export type NetHitReport = {
  /** the player who took it */
  victim: string;
  /** what they should lose — the shooter's read of their own weapon */
  dmg: number;
  head: boolean;
  /** the generation of *their* body the shot was aimed at */
  epoch: number;
  /** where we fired from: the victim checks the path against the world */
  origin: NetShotOrigin;
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
  /** Our own shot landed on a remote player. */
  onNetHit?: (hit: NetHitReport) => void;
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
  /**
   * A remote player's shot landed on us.
   *
   * We are the authority on our own body, so this does not blindly apply the
   * damage: the shot is validated against where we were `rewindMs` ago (their
   * half round trip) and against the world between the two points. `origin` is
   * where the shooter fired from; without it the geometric checks are skipped.
   */
  takeNetHit(dmg: number, killerId: string, rewindMs?: number, origin?: NetShotOrigin): void;
  /**
   * Our measured half round trip to the host, in ms, from the net layer. The
   * engine leads moving targets by this much when a shot is fired, and rewinds
   * its own body by the same when one arrives — two ends of the same fix for
   * "my bullets go where they were, not where they are".
   */
  setNetLatency(ms: number): void;
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
