// Headless checks for the online-play transport configuration.
//
// Run with `bun scripts/check-net.ts`. These are the parts of a WebRTC match
// that can be verified without two devices: the TURN credential format (against
// an independent HMAC implementation), the ICE server filtering that decides
// what the browser is even allowed to try, and the failure classification the
// player sees. The relay handshake itself still needs two real networks — see
// the report at the end.

import { createHmac } from "node:crypto";
import {
  base64,
  buildTurnPayload,
  corsHeadersFor,
  mintTurnCredential,
  originAllowed,
  parseTurnUrls,
} from "../src/convex/turn";
import { describeIce, diagnoseIceFailure, emptyTally, NetSession, sanitizeIceServers, type CandidateTally } from "../src/game/net";
import {
  brokerConfigProblem,
  classifySignalError,
  DEFAULT_BROKER,
  describeBroker,
  exhaustedSignalText,
  MAX_SIGNAL_ATTEMPTS,
  nextSignalBackoff,
  readBrokerConfig,
  SIGNAL_RETRY_DELAYS_MS,
} from "../src/game/signaling";
import {
  clearRoomLease,
  codeForCreate,
  drawRoomCode,
  isValidRoomCode,
  parseRoomLease,
  readRoomLease,
  ROOM_LEASE_KEY,
  ROOM_LEASE_TTL_MS,
  writeRoomLease,
} from "../src/game/room";

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
  const userinfo = describeIce([{ urls: ["turns://user:pass@relay.example.com:443"], username: "u", credential: "c" }]);
  check(
    "describeIce redacts userinfo embedded in a relay URL",
    !userinfo.includes("user:pass") && userinfo.includes("***@"),
    userinfo,
  );
}

/* --------------------------- signaling broker --------------------------- */
{
  const base = readBrokerConfig({});
  check(
    "default broker is the PeerJS cloud endpoint",
    base.host === DEFAULT_BROKER.host && base.port === 443 && base.secure && base.path === "/",
    describeBroker(base),
  );
  const custom = readBrokerConfig({
    VITE_PEER_HOST: "signal.example.com",
    VITE_PEER_PORT: "8443",
    VITE_PEER_PATH: "peerjs",
    VITE_PEER_KEY: "doodle",
    VITE_PEER_SECURE: "1",
  });
  check(
    "a self-hosted broker is read from VITE_PEER_* and paths are normalised",
    custom.host === "signal.example.com" &&
      custom.port === 8443 &&
      custom.path === "/peerjs/" &&
      custom.key === "doodle" &&
      custom.secure,
    describeBroker(custom),
  );
  const insecure = readBrokerConfig({ VITE_PEER_SECURE: "0", VITE_PEER_PORT: "8080" });
  check("VITE_PEER_SECURE=0 disables wss", insecure.secure === false, describeBroker(insecure));
  check(
    "https + ws:// is reported as mixed content before the socket is attempted",
    /mixed content/i.test(brokerConfigProblem(insecure, "https:") ?? ""),
  );
  check("ws:// on http is allowed", brokerConfigProblem(insecure, "http:") === null);
  check("wss:// on https is allowed", brokerConfigProblem(base, "https:") === null);

  const delays = [0, 1, 2, 3, 4].map((n) => nextSignalBackoff(n));
  check(
    "signaling backoff doubles and stays bounded",
    delays.join(",") === SIGNAL_RETRY_DELAYS_MS.join(",") && nextSignalBackoff(MAX_SIGNAL_ATTEMPTS) === null,
    `delays ${delays.join(",")}`,
  );
  check("signaling retries are finite", Number.isFinite(MAX_SIGNAL_ATTEMPTS) && MAX_SIGNAL_ATTEMPTS < 10, `${MAX_SIGNAL_ATTEMPTS}`);
}

/* ---------------------- signaling failure classification ---------------------- */
{
  const unavailable = classifySignalError({ type: "network", message: "Lost connection to server." });
  check("a dead broker socket is broker-unreachable and retriable", unavailable.kind === "broker-unreachable" && unavailable.retriable);
  check("the broker error text does not blame TURN", !/turn|relay|firewall/i.test(unavailable.text), unavailable.text);

  const timeout = classifySignalError({ type: "signal-timeout" });
  check("our own watchdog is broker-timeout, not ICE", timeout.kind === "broker-timeout" && timeout.retriable);

  const taken = classifySignalError({ type: "unavailable-id" });
  check("ID-TAKEN is room-in-use and not retriable", taken.kind === "room-in-use" && !taken.retriable);
  check("room-in-use tells the player to replace the room", /leave|new room/i.test(taken.text), taken.text);

  const missing = classifySignalError({ type: "peer-unavailable" });
  check("an unregistered host is room-not-found, not a relay failure", missing.kind === "room-not-found");
  check("room-not-found never mentions TURN_URLS / TURN_SECRET", !/TURN_URLS|TURN_SECRET|relay/i.test(missing.text), missing.text);

  const key = classifySignalError({ type: "invalid-key" });
  check("invalid broker key is fatal", key.kind === "invalid-key" && !key.retriable);
  const browser = classifySignalError({ type: "browser-incompatible" });
  check("browser-incompatible is fatal", browser.kind === "incompatible" && !browser.retriable);
  const exhausted = exhaustedSignalText(unavailable, MAX_SIGNAL_ATTEMPTS);
  check(
    "an exhausted broker cycle says it is not a TURN problem",
    /not a TURN\/relay problem/i.test(exhausted) && /5 attempts/.test(exhausted),
    exhausted,
  );
  check("classification detail is log-safe", !/credential=|password|secret/i.test(unavailable.detail + missing.detail));
}

/* ------------------------------ TURN endpoint CORS ------------------------------ */
{
  const open = corsHeadersFor("https://game.example", "");
  check("unconfigured TURN_ALLOWED_ORIGINS allows any origin", open["Access-Control-Allow-Origin"] === "*");
  check("the credential response is never cacheable", open["Cache-Control"] === "no-store" && open.Vary === "Origin");

  const allowed = corsHeadersFor("https://game.example", "https://game.example, https://staging.example");
  check("a listed origin is echoed exactly", allowed["Access-Control-Allow-Origin"] === "https://game.example");
  const slashy = corsHeadersFor("https://Game.Example", "https://game.example/");
  check(
    "a trailing slash / host case in TURN_ALLOWED_ORIGINS does not break CORS",
    slashy["Access-Control-Allow-Origin"] === "https://Game.Example",
    String(slashy["Access-Control-Allow-Origin"]),
  );

  const foreign = corsHeadersFor("https://evil.example", "https://game.example");
  check(
    "an unlisted origin gets no Access-Control-Allow-Origin at all",
    foreign["Access-Control-Allow-Origin"] === undefined,
    String(foreign["Access-Control-Allow-Origin"]),
  );
  check("originAllowed enforces the configured list", originAllowed("https://game.example", "https://game.example"));
  check("originAllowed rejects a foreign origin", !originAllowed("https://evil.example", "https://game.example"));
  check("originAllowed rejects a missing origin when a list is configured", !originAllowed(null, "https://game.example"));
  check("originAllowed is open when no list is configured", originAllowed(null, ""));
}

/* ------------------------------- room lease ------------------------------- */
{
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const NOW = 1_800_000_000_000;

  const fresh = readRoomLease(storage, NOW);
  check("an empty tab has no room lease", fresh === null);

  check("drawn codes are valid room codes", isValidRoomCode(drawRoomCode()) && drawRoomCode().length === 4);
  check("short and over-long codes are refused", !isValidRoomCode("AB") && !isValidRoomCode("ABCDEFGHI"));
  check("a code is stable for a fixed random source", drawRoomCode(() => 0.42) === drawRoomCode(() => 0.42));

  const first = codeForCreate(storage, NOW, () => 0.1);
  check("the first CREATE draws a code", first.resumed === false && isValidRoomCode(first.code), first.code);
  writeRoomLease(storage, { code: first.code, isHost: true, createdAt: NOW });

  // simulates a remount/reload: same storage, later clock, same code
  const second = codeForCreate(storage, NOW + 60_000, () => 0.9);
  check("a remount resumes the same host room code", second.resumed === true && second.code === first.code, second.code);
  check("the lease is scoped to this tab's room key", store.has(ROOM_LEASE_KEY));

  const expired = codeForCreate(storage, NOW + ROOM_LEASE_TTL_MS + 1, () => 0.9);
  check("an expired lease draws a new code", expired.resumed === false);

  const guestLease = { code: "ZZZZ", isHost: false, createdAt: NOW };
  writeRoomLease(storage, guestLease);
  const hostAfterGuest = codeForCreate(storage, NOW + 10_000, () => 0.2);
  check("a guest lease is not reused for hosting", hostAfterGuest.resumed === false && hostAfterGuest.code !== "ZZZZ");

  clearRoomLease(storage);
  check("LEAVE clears the lease", readRoomLease(storage, NOW) === null);

  check("malformed leases are rejected", parseRoomLease("{nope", NOW) === null);
  check("a lease with a bad code is rejected", parseRoomLease(JSON.stringify({ ...guestLease, code: "!!" }), NOW) === null);
  check(
    "a lease older than its TTL is rejected",
    parseRoomLease(JSON.stringify({ ...guestLease, createdAt: NOW - ROOM_LEASE_TTL_MS - 1 }), NOW) === null,
  );
  check(
    "a lease from the future is rejected rather than trusted",
    parseRoomLease(JSON.stringify({ ...guestLease, createdAt: NOW + 5 * 60_000 }), NOW) === null,
  );
  check("blocked storage does not throw", readRoomLease({ getItem: () => { throw new Error("denied"); } }, NOW) === null);
}

/* --------------------- confirmed room membership --------------------- */
{
  // NetSession uses window timers; Bun has the functions but no `window`.
  const g = globalThis as unknown as { window?: unknown };
  if (!g.window) g.window = globalThis;

  type Internals = {
    me: string;
    receive: (from: string, env: unknown) => void;
    onBrokerOpen: (id: string) => void;
    onBrokerLost: (detail: string) => void;
  };
  const internals = (s: NetSession) => s as unknown as Internals;

  const host = new NetSession("C86L", "Shashi", true, { map: "district", grapple: true });
  check("a host is not in the room before the broker accepts its id", host.joined === false && host.getPlayers().length === 0);
  internals(host).onBrokerOpen(host.hostId);
  check(
    "after broker OPEN the host row appears",
    host.joined === true && host.getPlayers().length === 1 && host.getPlayers()[0].isHost === true,
    JSON.stringify(host.getPlayers().map((p) => [p.name, p.isHost])),
  );
  internals(host).onBrokerLost("test disconnect");
  check(
    "a host with no guests stops advertising itself when its broker socket dies",
    host.joined === false && host.getPlayers().length === 0,
  );
  host.close();

  const guest = new NetSession("C86L", "Guest", false, { map: "district", grapple: true });
  internals(guest).me = "guest-1";
  check("a guest is not in the room before the host's roster lists it", guest.joined === false && guest.getPlayers().length === 0);

  internals(guest).receive("ds-pvp-C86L", {
    t: "roster",
    from: "ds-pvp-C86L",
    list: [{ id: "ds-pvp-C86L", name: "Shashi", ink: 0, ready: true }],
  });
  check(
    "a roster that omits the guest does not confirm membership",
    guest.joined === false && guest.getPlayers().length === 0,
    `${guest.getPlayers().length} player(s)`,
  );

  internals(guest).receive("ds-pvp-C86L", {
    t: "roster",
    from: "ds-pvp-C86L",
    list: [
      { id: "ds-pvp-C86L", name: "Shashi", ink: 0, ready: true },
      { id: "guest-1", name: "Guest", ink: 1, ready: false },
    ],
  });
  const roster = guest.getPlayers();
  check(
    "a roster that lists the guest confirms membership and the player count",
    guest.joined === true && roster.length === 2 && roster.some((p) => p.isMe) && roster.some((p) => p.isHost),
    `${roster.length} player(s)`,
  );
  guest.close();
}

/* ---------------------- TURN diagnosis provenance ---------------------- */
{
  const tally: CandidateTally = { ...emptyTally(), host: 1, srflx: 1, total: 2 };
  const cors = diagnoseIceFailure({ relay: "none", issue: "endpoint-unreachable", note: "TypeError: Failed to fetch", tally });
  check("a CORS/unreachable credential endpoint is not blamed on TURN_URLS", !/TURN_URLS \+ TURN_SECRET/.test(cors.text), cors.text);
  check("it points at the Convex site URL / origins", /Convex|VITE_CONVEX|ALLOWED_ORIGINS/i.test(cors.text), cors.text);

  const noSite = diagnoseIceFailure({ relay: "none", issue: "no-endpoint", tally });
  check("a missing frontend Convex URL is named exactly", /VITE_CONVEX_SITE_URL/.test(noSite.text), noSite.text);

  const rejected = diagnoseIceFailure({ relay: "none", issue: "endpoint-rejected", note: "the relay credential service answered HTTP 403", tally });
  check("an HTTP rejection stays in the message", /403/.test(rejected.text) && /TURN_ALLOWED_ORIGINS/.test(rejected.text), rejected.text);

  const expired = diagnoseIceFailure({
    relay: "deployment",
    tally: { ...emptyTally(), host: 1, total: 1 },
    expiresAt: NOW * 1000 - 1000,
    now: NOW * 1000,
  });
  check("expired relay credentials are identified as such", expired.kind === "relay-auth" && /expired/i.test(expired.text), expired.text);

  const plain = diagnoseIceFailure({ relay: "none", issue: "unconfigured", note: "TURN_URLS is not set", tally });
  check("a genuinely unconfigured relay still names TURN_URLS + TURN_SECRET", /TURN_URLS/.test(plain.text) && /TURN_SECRET/.test(plain.text));
}

console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
