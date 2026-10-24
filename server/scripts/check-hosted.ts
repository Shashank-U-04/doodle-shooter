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
const LEAVE_TIMEOUT_MS = 5000;
const CONSENTED = 4000;
type CheckRoom = {
  roomId: string;
  state: unknown;
  reconnection: { enabled: boolean };
  connection: { close(code?: number, reason?: string): void };
  leave(consented?: boolean): Promise<number>;
  onLeave(cb: (code: number) => void): void;
  send(type: string, message: unknown): void;
};
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
/**
 * Leave as the game does (leaveRoom in src/game/colyseus.ts): announce the
 * leave, then close from this side. Render loses closes the server starts, so
 * the SDK's plain leave() would wait for a close that never comes.
 */
const leaveAsTheGame = (room: CheckRoom) => {
  room.reconnection.enabled = false;
  const left = room.leave(true);
  room.connection.close(CONSENTED, "consented");
  return within(left, LEAVE_TIMEOUT_MS);
};
try {
  const client = new Client(server);
  const host = (await client.create("match", { name: "CHECK" })) as unknown as CheckRoom;
  const guest = (await client.joinById(host.roomId, { name: "CHECK2" })) as unknown as CheckRoom;
  const seen = () => (host.state as { players?: { size: number } }).players?.size;
  let deadline = Date.now() + 5000;
  while (seen() !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check("a room can be created and joined by code", seen() === 2, `room ${host.roomId}`);
  const guestLeft = await leaveAsTheGame(guest);
  check("a guest's LEAVE completes (close code 4000)", guestLeft === CONSENTED, `got ${guestLeft}`);
  deadline = Date.now() + 5000;
  while (seen() !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  check("the host sees the guest gone at once (seat released, not held)", seen() === 1, `players ${seen()}`);
  const hostLeft = await leaveAsTheGame(host);
  check("the last player's LEAVE completes (close code 4000)", hostLeft === CONSENTED, `got ${hostLeft}`);
} catch (e) {
  check("a room can be created and joined by code", false, String(e));
}

// 6. information, not a pass/fail: does a close the *server* starts reach the
// client? (Render lost them on 2026-10-24; kicks and shutdowns then arrive as a
// late 1006.) A malformed message makes the server close this probe's own room.
try {
  const probe = (await new Client(server).create("match", { name: "CHECK3" })) as unknown as CheckRoom;
  probe.reconnection.enabled = false;
  const closed = new Promise<number>((r) => probe.onLeave(r));
  probe.send("move", { x: "not a number" });
  const code = await within(closed, LEAVE_TIMEOUT_MS);
  console.log(`INFO  a server-initiated close reaches the client — ${code === "timeout" ? `no: nothing within ${LEAVE_TIMEOUT_MS / 1000} s (the hosting path loses it)` : `yes: code ${code}`}`);
  if (code === "timeout") probe.connection.close(CONSENTED);
} catch (e) {
  console.log(`INFO  a server-initiated close reaches the client — could not tell (${String(e)})`);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
