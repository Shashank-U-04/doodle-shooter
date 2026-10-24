// Process-wide room and tick metrics, logged as one JSON line a minute.
//
// What it answers, without a monitoring stack: how many rooms and players this
// instance holds, how long the rooms' simulation ticks take (the budget is the
// 50 ms patch interval), how many creates the limits refused, and how much
// memory the process uses. A line is written only while there is something to
// report, so an idle instance stays quiet.
//
//   {"event":"metrics","rooms":3,"players":9,"ticks":3600,"tickP50Ms":0.08,
//    "tickP95Ms":0.31,"tickMaxMs":2.4,"createsRefused":0,"rssMb":81,...}

/** Tick samples kept per window; beyond it, every other sample is dropped (the percentiles stay representative). */
const MAX_SAMPLES = 20_000;

export type MetricsSnapshot = {
  event: "metrics";
  windowS: number;
  rooms: number;
  players: number;
  ticks: number;
  tickP50Ms: number;
  tickP95Ms: number;
  tickP99Ms: number;
  tickMaxMs: number;
  createsRefused: number;
  roomsCreated: number;
  roomsDisposed: number;
  rssMb: number;
  heapUsedMb: number;
};

/** The q-quantile (0..1) of sorted values, nearest-rank. */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export class Metrics {
  private samples: number[] = [];
  private stride = 1;
  private seen = 0;
  private ticks = 0;
  private tickMax = 0;
  private createsRefused = 0;
  private roomsCreated = 0;
  private roomsDisposed = 0;
  private windowStart: number;

  constructor(private clock: () => number = Date.now) {
    this.windowStart = clock();
  }

  /** One room tick took `ms`. */
  tick(ms: number) {
    this.ticks++;
    if (ms > this.tickMax) this.tickMax = ms;
    if (this.seen++ % this.stride !== 0) return;
    this.samples.push(ms);
    if (this.samples.length >= MAX_SAMPLES) {
      this.samples = this.samples.filter((_, i) => i % 2 === 0);
      this.stride *= 2;
    }
  }

  createRefused() {
    this.createsRefused++;
  }

  roomCreated() {
    this.roomsCreated++;
  }

  roomDisposed() {
    this.roomsDisposed++;
  }

  /** Close the window: what happened in it, then start a new one. Null when nothing did. */
  flush(rooms: number, players: number, memory: { rss: number; heapUsed: number }): MetricsSnapshot | null {
    const now = this.clock();
    const quiet = rooms === 0 && this.ticks === 0 && this.createsRefused === 0 && this.roomsCreated === 0 && this.roomsDisposed === 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const snapshot: MetricsSnapshot = {
      event: "metrics",
      windowS: round((now - this.windowStart) / 1000, 1),
      rooms,
      players,
      ticks: this.ticks,
      tickP50Ms: round(quantile(sorted, 0.5)),
      tickP95Ms: round(quantile(sorted, 0.95)),
      tickP99Ms: round(quantile(sorted, 0.99)),
      tickMaxMs: round(this.tickMax),
      createsRefused: this.createsRefused,
      roomsCreated: this.roomsCreated,
      roomsDisposed: this.roomsDisposed,
      rssMb: Math.round(memory.rss / 2 ** 20),
      heapUsedMb: Math.round(memory.heapUsed / 2 ** 20),
    };
    this.samples = [];
    this.stride = 1;
    this.seen = 0;
    this.ticks = 0;
    this.tickMax = 0;
    this.createsRefused = 0;
    this.roomsCreated = 0;
    this.roomsDisposed = 0;
    this.windowStart = now;
    return quiet ? null : snapshot;
  }
}

/** The process's collector; MatchRoom feeds it, app.config.ts logs it. */
export const metrics = new Metrics();
