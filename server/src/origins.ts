// Which browser origins may use this server.
//
// An Origin header only describes what a *browser* says about the page that
// opened the connection. It stops another website from driving our rooms from
// a visitor's browser; it does not identify or authenticate anyone, because any
// non-browser client can send whatever Origin it likes. Requests that carry no
// Origin at all (curl, health probes, server-side tools) are therefore allowed:
// rejecting them would add no protection.

/** Vite's dev server and `vite preview`, on both loopback spellings. */
export const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];

/**
 * Canonical form of one origin: `scheme://host[:port]`, lowercase, default port
 * dropped. Anything that is not a bare http(s) origin is rejected rather than
 * repaired, so a typo in the allow-list cannot widen it.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value || value === "null") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // DNS names and bracketed IPv6 only. URL() accepts `*` as a hostname, and a
  // wildcard entry must be reported as invalid, not stored as a literal.
  if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/.test(url.hostname)) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  if (value.endsWith("/")) return null;
  return url.origin;
}

export type OriginPolicy = {
  allowed: ReadonlySet<string>;
  /** entries of ALLOWED_ORIGINS that were not valid origins (log-safe) */
  rejected: string[];
};

/**
 * Build the allow-list from `ALLOWED_ORIGINS` (comma separated, exact origins).
 * Outside production the Vite dev origins are always included. In production
 * an unset list allows no browser origin at all: failing closed is the only
 * safe default when nobody said where the frontend lives.
 */
export function readOriginPolicy(env: Record<string, string | undefined>): OriginPolicy {
  const allowed = new Set<string>();
  const rejected: string[] = [];
  if (env.NODE_ENV !== "production") for (const o of DEV_ORIGINS) allowed.add(o);
  for (const entry of String(env.ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const origin = normalizeOrigin(trimmed);
    if (origin) allowed.add(origin);
    else rejected.push(trimmed);
  }
  return { allowed, rejected };
}

/** True when a request with this Origin header may proceed. */
export function isOriginAllowed(header: string | null | undefined, policy: OriginPolicy): boolean {
  if (header === null || header === undefined || header === "") return true;
  const origin = normalizeOrigin(header);
  return origin !== null && policy.allowed.has(origin);
}

/** The policy this process runs with, read once at startup. */
export const originPolicy = readOriginPolicy(process.env);
