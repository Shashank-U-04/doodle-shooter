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

export type GameOverStats = {
  wave: number;
  kills: number;
  score: number;
  best: boolean;
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
  onLockLost: () => void;
  onLockChange: (locked: boolean) => void;
  onAim: (ads: boolean) => void;
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
}
