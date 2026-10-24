// Check a deployed match server from the outside, the way browsers will use it.
//
//   npm run check:hosted -- --server https://<server-host> --origin https://<preview-origin>
//
// `--origin` is the Vercel Preview origin that ALLOWED_ORIGINS should contain.
// Read-only apart from one short-lived test room (created, joined, left).
// Prints no headers or tokens; exits 1 if any check fails.
import { Client } from "@colyseus/sdk";
import WebSocket from "ws";

/** An origin no deployment should allow (.invalid never resolves). */
const FOREIGN = "https://not-allowed.invalid";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) {
    console.error("usage: npm run check:hosted -- --server https://<server-host> --origin https://<preview-origin>");
    process.exit(2);
  }
  return value.replace(/\/+$/, "");
}

const server = arg("server");
const origin = arg("origin");
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const preflight = (from: string) =>
  fetch(`${server}/matchmake/create/match`, {
    method: "OPTIONS",
    headers: { Origin: from, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
  });

/** Status of a WebSocket upgrade sent with this Origin: a number when refused, "open" when accepted. */
const upgrade = (from: string) =>
  new Promise<number | "open" | string>((resolve) => {
    const ws = new WebSocket(server.replace(/^http/, "ws") + "/", { headers: { Origin: from } });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve("timeout");
    }, 15_000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode ?? 0);
    });
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve("open");
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      resolve(`error: ${e.message}`);
    });
  });

console.log(`server ${server}\nallowed origin ${origin}\n`);

// 1. health (a free-tier host may take about a minute to wake on the first request)
const started = Date.now();
try {
  const res = await fetch(`${server}/health`, { signal: AbortSignal.timeout(120_000) });
  const body = (await res.json().catch(() => ({}))) as { status?: string };
  check("/health answers 200 {status: ok}", res.status === 200 && body.status === "ok", `${res.status} in ${Date.now() - started} ms`);
} catch (e) {
  check("/health answers 200 {status: ok}", false, String(e));
  console.log("\nThe server is unreachable; nothing else can be checked.");
  process.exit(1);
}

// 2. CORS: the Preview is named, anyone else is not, and never `*`
const allowed = await preflight(origin);
const named = allowed.headers.get("access-control-allow-origin");
check("CORS names the Preview origin", named === origin, named === origin ? "" : `got ${named ?? "none"} — is it in ALLOWED_ORIGINS exactly?`);
check("CORS allows credentials only alongside it", allowed.headers.get("access-control-allow-credentials") === "true");
const foreign = await preflight(FOREIGN);
check("CORS names no other origin", foreign.headers.get("access-control-allow-origin") === null, `got ${foreign.headers.get("access-control-allow-origin") ?? "none"}`);

// 3. matchmaking and sockets refuse other origins
const refused = await fetch(`${server}/matchmake/create/match`, {
  method: "POST",
  headers: { Origin: FOREIGN, "Content-Type": "application/json" },
  body: "{}",
});
check("matchmaking refuses another origin", refused.status === 403, `status ${refused.status}`);
const wsForeign = await upgrade(FOREIGN);
check("WebSocket upgrade refuses another origin", wsForeign === 403, String(wsForeign));
const wsAllowed = await upgrade(origin);
check("WebSocket upgrade accepts the Preview origin", wsAllowed !== 403 && !String(wsAllowed).startsWith("error") && wsAllowed !== "timeout", String(wsAllowed));

// 4. production mode: no room monitor, no test fixtures
check("/monitor is not served (NODE_ENV=production)", (await fetch(`${server}/monitor`)).status === 404);
check(
  "test fixtures are not mounted (no E2E_FIXTURES)",
  (await fetch(`${server}/__e2e/rooms/TEST/win`, { method: "POST" })).status === 404,
);

// 5. a real room: create, join by code, both see two players, both leave cleanly
/** A consented leave: the server closes the socket with CONSENTED (4000). Bounded, so a lost close frame fails instead of hanging. */
const LEAVE_TIMEOUT_MS = 5000;
const CONSENTED = 4000;
const leaveWithin = (room: { leave(consented?: boolean): Promise<number> }) =>
  Promise.race([room.leave(true), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), LEAVE_TIMEOUT_MS))]);
try {
  const client = new Client(server);
  const host = await client.create("match", { name: "CHECK" });
  const guest = await client.joinById(host.roomId, { name: "CHECK2" });
  const seen = () => (host.state as { players?: { size: number } }).players?.size;
  const deadline = Date.now() + 5000;
  while (seen() !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check("a room can be created and joined by code", seen() === 2, `room ${host.roomId}`);
  // If the close frame never arrives (seen through Render's proxy on 2026-10-24,
  // never locally), the SDK treats the leave as a drop and keeps reconnecting.
  const guestLeft = await leaveWithin(guest);
  check("a guest's LEAVE completes (close code 4000)", guestLeft === CONSENTED, `got ${guestLeft}`);
  const hostLeft = await leaveWithin(host);
  check("the last player's LEAVE completes (close code 4000)", hostLeft === CONSENTED, `got ${hostLeft}`);
} catch (e) {
  check("a room can be created and joined by code", false, String(e));
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
