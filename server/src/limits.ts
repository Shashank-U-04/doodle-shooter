// Abuse limits on creating rooms.
//
// Three layers, checked in this order:
//
//  1. a ceiling on live rooms in this process (`MAX_ROOMS`);
//  2. a budget of creates per minute per client address
//     (`ROOM_CREATES_PER_IP_PER_MINUTE`);
//  3. a budget of creates per minute for the whole process
//     (`ROOM_CREATES_PER_MINUTE`).
//
// The per-address layer is defence in depth, not a guarantee. Colyseus takes
// the address from the first X-Real-IP / X-Forwarded-For entry, which a client
// can set itself unless the host's proxy overwrites it. So 1 and 3 do not
// depend on knowing who is asking: they hold whatever a client claims to be.
//
// Each budget is a token bucket that holds one minute's worth (the burst) and
// refills continuously. A refused create costs nothing.

export type RoomLimits = {
  /** live rooms this process will hold */
  maxRooms: number;
  /** creates per minute across the process */
  createsPerMinute: number;
  /** creates per minute from one client address */
  createsPerIpPerMinute: number;
};

/**
 * Provisional defaults for one small instance (512 MB), pending a load test.
 * 100 rooms is 400 players at most.
 */
export const DEFAULT_ROOM_LIMITS: RoomLimits = { maxRooms: 100, createsPerMinute: 60, createsPerIpPerMinute: 6 };

const ENV_NAMES: Record<keyof RoomLimits, string> = {
  maxRooms: "MAX_ROOMS",
  createsPerMinute: "ROOM_CREATES_PER_MINUTE",
  createsPerIpPerMinute: "ROOM_CREATES_PER_IP_PER_MINUTE",
};

/** Limits from the environment: positive integers; anything else keeps the default and is reported. */
export function readRoomLimits(env: Record<string, string | undefined>): { limits: RoomLimits; rejected: string[] } {
  const limits = { ...DEFAULT_ROOM_LIMITS };
  const rejected: string[] = [];
  for (const key of Object.keys(ENV_NAMES) as (keyof RoomLimits)[]) {
    const raw = env[ENV_NAMES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) limits[key] = value;
    else rejected.push(ENV_NAMES[key]);
  }
  return { limits, rejected };
}

/** The limits this process runs with, read once at startup (like origins.ts). */
export const roomLimitsFromEnv = readRoomLimits(process.env);

/** A token bucket: `capacity` tokens, refilled at `perMinute` per minute. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  constructor(
    private capacity: number,
    private perMinute: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.at = now;
  }

  private refill(now: number) {
    if (now > this.at) this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) * this.perMinute) / 60_000);
    this.at = Math.max(this.at, now);
  }

  /** Whether a token is available, without taking it. */
  peek(now: number): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  take(now: number): boolean {
    if (!this.peek(now)) return false;
    this.tokens -= 1;
    return true;
  }

  /** Back to full: nothing left to remember about this caller. */
  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }
}

export type CreateRefusal = "too-many-rooms" | "too-fast" | "server-busy";

/** What a refused client is told (HTTP 429 from matchmaking). */
export const REFUSAL_TEXT: Record<CreateRefusal, string> = {
  "too-many-rooms": "the match server is full right now",
  "too-fast": "too many matches created from this address; wait a minute",
  "server-busy": "too many matches are being created right now; wait a minute",
};

/** Addresses remembered at most; the oldest idle ones are forgotten first. */
const MAX_TRACKED = 10_000;

export class RoomCreationLimiter {
  private limits: RoomLimits;
  private global: TokenBucket;
  private perIp = new Map<string, TokenBucket>();

  constructor(
    limits: RoomLimits = DEFAULT_ROOM_LIMITS,
    private clock: () => number = Date.now,
  ) {
    this.limits = limits;
    this.global = new TokenBucket(limits.createsPerMinute, limits.createsPerMinute, clock());
  }

  /** Replace the limits (tests; a future admin hook). Budgets restart full. */
  configure(limits: RoomLimits) {
    this.limits = limits;
    this.global = new TokenBucket(limits.createsPerMinute, limits.createsPerMinute, this.clock());
    this.perIp.clear();
  }

  get current(): RoomLimits {
    return { ...this.limits };
  }

  /**
   * May `ip` create a room while `liveRooms` exist? Takes from both budgets
   * only when the answer is yes. `ip` is undefined when no proxy header names
   * one (local runs); those callers share one budget.
   */
  tryCreate(ip: string | undefined, liveRooms: number): CreateRefusal | null {
    const now = this.clock();
    if (liveRooms >= this.limits.maxRooms) return "too-many-rooms";
    const key = ip ?? "(unknown)";
    let mine = this.perIp.get(key);
    if (!mine) {
      mine = new TokenBucket(this.limits.createsPerIpPerMinute, this.limits.createsPerIpPerMinute, now);
      this.remember(key, mine, now);
    }
    if (!mine.peek(now)) return "too-fast";
    if (!this.global.peek(now)) return "server-busy";
    mine.take(now);
    this.global.take(now);
    return null;
  }

  /** How many addresses are remembered (tests, metrics). */
  get tracked(): number {
    return this.perIp.size;
  }

  private remember(key: string, bucket: TokenBucket, now: number) {
    if (this.perIp.size >= MAX_TRACKED) {
      // forget everyone whose budget has refilled; failing that, the oldest entry
      for (const [k, b] of this.perIp) if (b.full(now)) this.perIp.delete(k);
      if (this.perIp.size >= MAX_TRACKED) this.perIp.delete(this.perIp.keys().next().value!);
    }
    this.perIp.set(key, bucket);
  }
}

/** True for a matchmaking request that creates a room (`POST /matchmake/create/:room`). */
export function isCreateRequest(req: unknown): boolean {
  const url = (req as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string") return false;
  try {
    return /^\/matchmake\/create\//.test(new URL(url, "http://local").pathname);
  } catch {
    return false;
  }
}
