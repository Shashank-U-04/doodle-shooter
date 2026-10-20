// Headless checks for the online-play transport configuration.
//
// Run with `bun scripts/check-net.ts`. These are the parts of a WebRTC match
// that can be verified without two devices: the TURN credential format (against
// an independent HMAC implementation), the ICE server filtering that decides
// what the browser is even allowed to try, and the failure classification the
// player sees. The relay handshake itself still needs two real networks — see
// the report at the end.

import { createHmac } from "node:crypto";
import { base64, buildTurnPayload, mintTurnCredential, parseTurnUrls } from "../src/convex/turn";
import { describeIce, diagnoseIceFailure, emptyTally, sanitizeIceServers, type CandidateTally } from "../src/game/net";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const NOW = 1_800_000_000;

/* ------------------------------ base64 ------------------------------ */
{
  let ok = true;
  for (let n = 0; n < 40; n++) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 37 + n * 11) & 0xff;
    if (base64(bytes) !== Buffer.from(bytes).toString("base64")) ok = false;
  }
  check("base64 matches the standard encoder for 0..39 byte inputs", ok);
}

/* ------------------------ TURN credential minting ------------------------ */
{
  const secret = "relay-shared-secret";
  const urls = ["turn:relay.example.com:3478", "turns:relay.example.com:443?transport=tcp"];
  const minted = mintTurnCredential(secret, urls, 3600, NOW);
  const expectedName = `${NOW + 3600}:doodle`;
  const expected = createHmac("sha1", secret).update(expectedName).digest("base64");
  check("username is `<unix expiry>:<label>`", minted.username === expectedName, minted.username);
  check("credential is base64(HMAC-SHA1(secret, username))", minted.credential === expected, minted.credential);
  check("minted credential carries both UDP and TLS relay URLs", minted.urls.length === 2);
  check("expiry is now + ttl", minted.expiresAt === NOW + 3600);
}

/* ---------------------------- URL validation ---------------------------- */
{
  const kept = parseTurnUrls(
    "turn:relay.example.com:3478, turns:relay.example.com:443?transport=tcp ,turn:relay.example.com:3478, http://evil.example, stun:stun.example:3478, not-a-url",
  );
  check("TURN_URLS keeps turn:/turns: URLs and dedupes them", kept.length === 2, JSON.stringify(kept));
  check(
    "TURN_URLS rejects http: and stun: entries",
    kept.every((u) => /^turns?:/i.test(u)),
  );
  check("empty TURN_URLS yields no servers", parseTurnUrls("").length === 0 && parseTurnUrls(undefined).length === 0);
}

/* --------------------------- endpoint behaviour --------------------------- */
{
  const none = buildTurnPayload({ nowSeconds: NOW });
  check("no TURN_URLS reports configured:false", none.configured === false && none.iceServers.length === 0);
  check("no TURN_URLS reason names the missing variable", /TURN_URLS/.test(none.reason ?? ""), none.reason);

  const noSecret = buildTurnPayload({ urls: "turn:relay.example.com:3478", nowSeconds: NOW });
  check("TURN_URLS without TURN_SECRET is not configured", noSecret.configured === false);
  check("missing secret reason names TURN_SECRET", /TURN_SECRET/.test(noSecret.reason ?? ""), noSecret.reason);

  const badUrls = buildTurnPayload({ urls: "http://x, stun:y:3478", secret: "s", nowSeconds: NOW });
  check("non-relay URLs are refused even with a secret", badUrls.configured === false);

  const good = buildTurnPayload({
    urls: "turn:relay.example.com:3478,turns:relay.example.com:443?transport=tcp",
    secret: "super-secret-value",
    ttl: "120",
    nowSeconds: NOW,
  });
  const body = JSON.stringify(good);
  check("configured deployment returns one credential covering both URLs", good.configured && good.iceServers.length === 1);
  check("requested TTL is honoured", good.ttl === 120 && good.expiresAt === NOW + 120, `${good.ttl}s`);
  check("the shared secret never appears in the response", !body.includes("super-secret-value"));
  check("the response never contains the secret under a credential-shaped key", !/"secret"/i.test(body));

  const capped = buildTurnPayload({ urls: "turn:r:3478", secret: "s", ttl: "999999", nowSeconds: NOW });
  check("TTL is capped at one day", capped.ttl === 86400, `${capped.ttl}s`);
  const fallback = buildTurnPayload({ urls: "turn:r:3478", secret: "s", ttl: "nonsense", nowSeconds: NOW });
  check("invalid TTL falls back to one hour", fallback.ttl === 3600, `${fallback.ttl}s`);
}

/* ------------------------- ICE server filtering ------------------------- */
{
  const clean = sanitizeIceServers([
    { urls: "turn:relay.example.com:3478", username: "u", credential: "c" },
    { urls: ["turns:relay.example.com:443?transport=tcp"], username: "u", credential: "c" },
    { urls: "stun:stun.example.com:19302" },
    { urls: "turn:nocreds.example.com:3478" },
    { urls: "http://not-ice.example" },
    "garbage",
    null,
  ]);
  check("valid relay entries survive sanitising", clean.relay === 2, `${clean.relay} relay entries`);
  check("a relay without credentials is dropped", clean.servers.every((s) => !String(s.urls).includes("nocreds")));
  check("STUN-only entries are kept", clean.servers.some((s) => String(s.urls).includes("stun:stun.example.com")));
  check("junk and non-ICE entries are counted as dropped", clean.dropped === 4, `${clean.dropped} dropped`);
  check(
    "no non-ICE URL ever reaches RTCPeerConnection",
    clean.servers.every((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).every((u) => /^(stuns?|turns?):/i.test(String(u)))),
  );
  check("a non-array payload yields no servers", sanitizeIceServers({ iceServers: [] }).servers.length === 0);
}

/* --------------------------- ICE diagnosis --------------------------- */
{
  const relayCfg = { relay: "deployment" as const };
  const tally = (host = 2, srflx = 1, relay = 0): CandidateTally => ({ ...emptyTally(), host, srflx, relay, total: host + srflx + relay });

  const nothing = diagnoseIceFailure({ ...relayCfg, relay: "none", tally: tally(0, 0, 0) });
  check("no candidates is its own failure kind", nothing.kind === "no-candidates", nothing.kind);

  const missing = diagnoseIceFailure({ relay: "none", note: "TURN_URLS is not set", tally: tally() });
  check("STUN-only deployment produces relay-missing", missing.kind === "relay-missing", missing.kind);
  check("relay-missing names the variables the operator must set", /TURN_URLS/.test(missing.text) && /TURN_SECRET/.test(missing.text));

  const auth = diagnoseIceFailure({ ...relayCfg, note: "the relay credential service answered HTTP 401", tally: tally() });
  check("credential rejection produces relay-auth", auth.kind === "relay-auth", auth.kind);

  const unreachable = diagnoseIceFailure({ ...relayCfg, tally: tally() });
  check("configured but never gathered produces relay-unreachable", unreachable.kind === "relay-unreachable", unreachable.kind);
  check("relay-unreachable recommends turns: on 443", /turns:/.test(unreachable.text) && /443/.test(unreachable.text));

  const blocked = diagnoseIceFailure({ ...relayCfg, tally: tally(2, 1, 2), iceState: "failed" });
  check("relay gathered but ICE failed produces relay-blocked", blocked.kind === "relay-blocked", blocked.kind);
  check("the console detail reports the candidate mix", /2 relay/.test(blocked.detail) && /ICE failed/.test(blocked.detail), blocked.detail);
  check("the player-facing text stays short", blocked.text.length < 180, `${blocked.text.length} chars`);

  const texts = [nothing.text, missing.text, auth.text, unreachable.text, blocked.text].join(" ");
  check("no failure message guesses 'mobile data' any more", !/mobile data/i.test(texts));
  check("every failure message is actionable, not a bare timeout", texts.length > 200);
  check(
    "failure text never leaks the credential service's response body",
    [nothing.text, missing.text, auth.text, unreachable.text, blocked.text].every((t) => !/test-secret|credential=/i.test(t)),
  );
}

/* --------------------------- log hygiene --------------------------- */
{
  const described = describeIce([
    { urls: ["turns:relay.example.com:443"], username: "1800000000:doodle", credential: "DO-NOT-LOG-THIS" },
  ]);
  check("describeIce shows the server kind and URL", /turn \(credentialed\)/.test(described) && /relay\.example\.com/.test(described));
  check("describeIce never prints the credential", !described.includes("DO-NOT-LOG-THIS"));
  check("describeIce never prints the username", !described.includes("1800000000:doodle"));
}

console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
