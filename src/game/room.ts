// A room lease: the code this tab is currently using, and whether it hosts.
//
// Why this exists: the room code used to be drawn inside `create()` only. Any
// remount therefore produced a brand-new room — and mobile Safari (and Chrome
// under memory pressure) reloads or discards background tabs, so switching tabs
// looked like the code rotated while the old room stayed alive with nobody in
// it. The lease makes the code survive a reload of the same tab, and makes a
// replacement explicit: LEAVE clears it, so the next CREATE gets a new code.
//
// The lease is stored in sessionStorage: it belongs to one tab, and two tabs
// must be able to host two different rooms. No secret is stored here.

export type RoomLease = {
  /** the 4-letter room code exactly as shown to the player */
  code: string;
  isHost: boolean;
  /** ms epoch the lease was written */
  createdAt: number;
};

/** How long a lease may be resumed before the room is treated as expired. */
export const ROOM_LEASE_TTL_MS = 6 * 60 * 60 * 1000;
export const ROOM_LEASE_KEY = "dd_room";
/**
 * The query parameter that carries a room code to /online (`/online?room=K7QM`).
 *
 * Not `code`: when the app ran Convex Auth, it treated `?code=` on any page as
 * its sign-in callback, stripped it, and signed the player out when the room
 * code failed as a sign-in code. That provider is gone; `code` is still read
 * for old links.
 */
export const ROOM_PARAM = "room";
export const LEGACY_ROOM_PARAM = "code";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_SHAPE = /^[A-Z0-9]{3,8}$/;

/** A room code the lobby will accept: uppercase letters/digits, 3–8 long. */
export function normalizeRoomCode(raw: unknown): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}

/** True when `code` is a syntactically valid room code. */
export function isValidRoomCode(code: string): boolean {
  return CODE_SHAPE.test(code);
}

/**
 * Draw a new code from the unambiguous alphabet (no O/0, no I/1).
 * Kept in net.ts as `makeRoomCode` for compatibility; this is the same shape.
 */
export function drawRoomCode(random: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return s;
}

/**
 * Parse a stored lease. Expired, malformed, or foreign-shaped values are
 * rejected rather than repaired, so a stale room is never silently reused with
 * a code the host is not actually holding.
 */
export function parseRoomLease(raw: string | null | undefined, now: number, ttl = ROOM_LEASE_TTL_MS): RoomLease | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as { code?: unknown; isHost?: unknown; createdAt?: unknown };
  const code = normalizeRoomCode(v.code);
  if (!isValidRoomCode(code)) return null;
  if (typeof v.isHost !== "boolean") return null;
  const createdAt = Number(v.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (createdAt > now + 60_000) return null; // clock moved backwards; do not trust
  if (now - createdAt > ttl) return null;
  return { code, isHost: v.isHost, createdAt };
}

export function serializeRoomLease(lease: RoomLease): string {
  return JSON.stringify({ code: normalizeRoomCode(lease.code), isHost: lease.isHost, createdAt: lease.createdAt });
}

type Readable = { getItem(key: string): string | null };
type Writable = { setItem(key: string, value: string): void };
type Removable = { removeItem(key: string): void };

/** Read the lease, tolerating blocked storage (Safari private mode, …). */
export function readRoomLease(storage: Readable | null | undefined, now: number): RoomLease | null {
  if (!storage) return null;
  try {
    return parseRoomLease(storage.getItem(ROOM_LEASE_KEY), now);
  } catch {
    return null;
  }
}

export function writeRoomLease(storage: Writable | null | undefined, lease: RoomLease): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ROOM_LEASE_KEY, serializeRoomLease(lease));
    return true;
  } catch {
    return false;
  }
}

export function clearRoomLease(storage: Removable | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(ROOM_LEASE_KEY);
  } catch {
    /* storage is unavailable; nothing to clear */
  }
}

/**
 * The code a CREATE should use: the live host lease when this tab already has
 * one, otherwise a new code. Deliberately does not rotate on a timer.
 */
export function codeForCreate(
  storage: Readable | null | undefined,
  now: number,
  random: () => number = Math.random,
): { code: string; resumed: boolean } {
  const lease = readRoomLease(storage, now);
  if (lease?.isHost) return { code: lease.code, resumed: true };
  return { code: drawRoomCode(random), resumed: false };
}
