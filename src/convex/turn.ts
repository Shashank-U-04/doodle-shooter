// TURN relay credentials, minted on the server.
//
// Why this exists: the game is peer-to-peer, and two browsers behind symmetric
// NATs (carrier CGNAT, most guest Wi-Fi, locked-down office networks) have no
// direct route at all. Only a relay can carry them, and a relay needs
// credentials. Putting a long-lived username/password in the client bundle
// would publish them to everyone who opens devtools, so the browser asks this
// endpoint for a short-lived credential instead — the shared secret never
// leaves the Convex deployment.
//
// The credential format is the standard TURN REST convention that coturn's
// `use-auth-secret`, Cloudflare's Realtime TURN and Metered's relay all accept:
//
//   username   = "<unix expiry>:<label>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
//
// Only TURN_URLS + TURN_SECRET need to be configured. With either missing this
// answers `{ configured: false, reason }` — not a 500 — so the client can say
// *why* online play has no relay instead of blaming the player's network.

import { hmac } from "@oslojs/crypto/hmac";
import { SHA1 } from "@oslojs/crypto/sha1";
import { httpAction } from "./_generated/server";

/** default lifetime of a minted credential, seconds */
const DEFAULT_TTL = 3600;
/** never hand out a credential that outlives this, even if TURN_TTL asks */
const MAX_TTL = 86400;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 — no padding-free variant, coturn expects the normal form. */
export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64[a >> 2];
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 0x3f];
  }
  return out;
}

/**
 * Keep only relay URLs the browser can actually dial.
 *
 * `turn:` and `turns:` only — a stray `http://` or a `stun:` entry in
 * TURN_URLS would be silently useless (or, worse, a credentialed STUN entry
 * that leaks the secret to a third party), so it is dropped here rather than
 * shipped to the client.
 */
export function parseTurnUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (!/^turns?:[^\s]+$/i.test(url)) continue;
    seen.add(url);
  }
  return [...seen];
}

export type TurnCredential = { urls: string[]; username: string; credential: string };

export type TurnPayload = {
  /** true only when a relay URL and a secret were both available */
  configured: boolean;
  iceServers: TurnCredential[];
  /** seconds the credential stays valid */
  ttl: number;
  /** unix seconds the credential expires */
  expiresAt?: number;
  /** why there is no relay — safe to show, never contains the secret */
  reason?: string;
};

export function mintTurnCredential(
  secret: string,
  urls: string[],
  ttlSeconds: number,
  nowSeconds: number,
  label = "doodle",
): TurnCredential & { expiresAt: number } {
  const expiresAt = Math.floor(nowSeconds) + Math.max(60, Math.floor(ttlSeconds));
  const username = `${expiresAt}:${label}`;
  const credential = base64(hmac(SHA1, new TextEncoder().encode(secret), new TextEncoder().encode(username)));
  return { urls, username, credential, expiresAt };
}

/** Pure: everything the endpoint decides, so the harness can test it offline. */
export function buildTurnPayload(opts: {
  urls?: string;
  secret?: string;
  ttl?: string;
  nowSeconds: number;
  label?: string;
}): TurnPayload {
  const urls = parseTurnUrls(opts.urls);
  if (urls.length === 0) {
    return {
      configured: false,
      iceServers: [],
      ttl: 0,
      reason: "TURN_URLS is not set on the Convex deployment (expected turn:/turns: URLs)",
    };
  }
  const secret = (opts.secret ?? "").trim();
  if (!secret) {
    return {
      configured: false,
      iceServers: [],
      ttl: 0,
      reason: "TURN_SECRET is not set on the Convex deployment, so relay credentials cannot be minted",
    };
  }
  const asked = Number.parseInt(opts.ttl ?? "", 10);
  const ttl = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_TTL, asked) : DEFAULT_TTL;
  const minted = mintTurnCredential(secret, urls, ttl, opts.nowSeconds, opts.label);
  return {
    configured: true,
    iceServers: [{ urls: minted.urls, username: minted.username, credential: minted.credential }],
    ttl,
    expiresAt: minted.expiresAt,
  };
}

/**
 * CORS: the game is served from a different origin than `<deployment>.convex.site`.
 *
 * `TURN_ALLOWED_ORIGINS` (comma separated) narrows this to the real game
 * origins. Unset means `*`, which is defensible here: the response is a
 * deliberately public, expiring relay credential, exactly like the open-relay
 * endpoints it replaces. It is never allowed to be cached.
 *
 * A configured origin that is *not* on the list gets no `Access-Control-Allow-
 * Origin` header at all. The old code echoed `configured[0]` in that case: a
 * blocked browser request looked like a normal 200 in logs, so the only visible
 * symptom was "no relay" in the game.
 */
/** Origins are schemes + hosts; a trailing slash or trailing space is a typo. */
const cleanOrigin = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();

export function allowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map(cleanOrigin)
    .filter(Boolean);
}

export function originAllowed(origin: string | null, raw?: string): boolean {
  const configured = allowedOrigins(raw);
  if (configured.length === 0) return true;
  return Boolean(origin && configured.includes(cleanOrigin(origin)));
}

export function corsHeadersFor(origin: string | null, raw?: string): Record<string, string> {
  const configured = allowedOrigins(raw);
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
  };
  if (configured.length === 0) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && configured.includes(cleanOrigin(origin))) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return corsHeadersFor(origin, process.env.TURN_ALLOWED_ORIGINS);
}

export const turnRequest = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  const allowed = originAllowed(origin, process.env.TURN_ALLOWED_ORIGINS);
  if (!allowed) {
    console.warn(`[turn] refused origin ${origin ?? "(none)"} (TURN_ALLOWED_ORIGINS does not list it)`);
    return new Response(JSON.stringify({ configured: false, reason: "this origin is not allowed to mint TURN credentials" }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
  const payload = buildTurnPayload({
    urls: process.env.TURN_URLS,
    secret: process.env.TURN_SECRET,
    ttl: process.env.TURN_TTL,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!payload.configured) console.warn(`[turn] relay unavailable: ${payload.reason}`);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
});

export const turnPreflight = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  const allowed = originAllowed(origin, process.env.TURN_ALLOWED_ORIGINS);
  return new Response(null, { status: allowed ? 204 : 403, headers: corsHeaders(origin) });
});
