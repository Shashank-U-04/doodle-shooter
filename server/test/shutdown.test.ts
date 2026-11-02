// Graceful shutdown of the real server process: a platform stops the service
// with SIGTERM (redeploy, restart, scale-down). Every player is sent the restart
// notice, their sockets are closed a moment later with SERVER_SHUTDOWN, every room
// is disposed, and the process exits cleanly. These tests run the real entry point
// and, on Linux and macOS, send a real signal (see test/fixtures/shutdown-child.ts
// for Windows). They do not go through a hosting platform.
import assert from "assert";
import { execSync, spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@colyseus/sdk";
import { NOTICE_GRACE_MS } from "../src/lifecycle.js";
import { SERVER_CLOSING_MESSAGE } from "../src/shared/rules.js";

const PORT = 2611;
const BASE = `http://127.0.0.1:${PORT}`;
/** @colyseus/shared-types CloseCode.SERVER_SHUTDOWN */
const SERVER_SHUTDOWN = 4001;
const serverDir = fileURLToPath(new URL("..", import.meta.url));

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for: ${what}`)), ms)),
  ]);
}

type Running = { proc: ChildProcess; output: () => string; exited: Promise<number | null>; term(): void };

/** Start the server on PORT, the way `how` says, and wait until /health answers. */
async function startServer(how: "entry-point" | "npm-run-serve" | "node-build" = "entry-point"): Promise<Running> {
  const env = { ...process.env, NODE_ENV: "production", PORT: String(PORT), ALLOWED_ORIGINS: "" };
  const proc =
    how === "entry-point"
      ? spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-child.ts"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
      : how === "node-build"
        ? spawn(process.execPath, ["build/index.js"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("npm", ["run", "serve"], { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout?.on("data", (d) => (output += d));
  proc.stderr?.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false);
    if (up) break;
    if (Date.now() > deadline) throw new Error(`server did not start:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    proc,
    exited,
    output: () => output,
    term: () => {
      if (process.platform === "win32") proc.send?.("SIGTERM");
      else proc.kill("SIGTERM");
    },
  };
}

/** The lifecycle log lines (src/lifecycle.ts) of a run. */
function lifecycle(output: string): { stage: string; [key: string]: unknown }[] {
  return output
    .split("\n")
    .filter((l) => l.includes('"event":"lifecycle"'))
    .map((l) => JSON.parse(l.slice(l.indexOf("{"))) as { stage: string });
}

/** Two players in a room, recording the notice and the close each one receives. */
async function twoPlayers() {
  const client = new Client(BASE);
  const host = await client.create("match", { name: "Ada" });
  const guest = await client.joinById(host.roomId, { name: "Grace" });
  const watch = (room: typeof host) => {
    const seen = { notices: [] as number[], closeCode: null as number | null, closedAt: 0 };
    const closed = new Promise<void>((resolve) =>
      room.onLeave((code) => {
        seen.closeCode = code;
        seen.closedAt = Date.now();
        resolve();
      }),
    );
    room.onMessage(SERVER_CLOSING_MESSAGE, () => seen.notices.push(Date.now()));
    return { seen, closed };
  };
  return { players: [watch(host), watch(guest)], host, guest };
}

describe("graceful shutdown", function () {
  this.timeout(60_000);
  let server: Running | null = null;

  afterEach(() => {
    const proc = server?.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    server = null;
  });

  it("on SIGTERM tells both players, then closes them, disposes the room and exits 0", async () => {
    server = await startServer();
    const { players, host } = await twoPlayers();
    const startedAt = Date.now();
    server.term();

    await within(Promise.all(players.map((p) => p.closed)), 15_000, "players closed");
    for (const { seen } of players) {
      assert.strictEqual(seen.closeCode, SERVER_SHUTDOWN, server.output());
      assert.strictEqual(seen.notices.length, 1, "exactly one notice");
      assert.ok(seen.closedAt - seen.notices[0] >= NOTICE_GRACE_MS - 100, `notice ${seen.closedAt - seen.notices[0]} ms before the close`);
    }
    assert.strictEqual(await within(server.exited, 15_000, "process exit"), 0, server.output());
    assert.ok(Date.now() - startedAt < 10_000, "shutdown is bounded");
    await assert.rejects(fetch(`${BASE}/health`), "nothing listening any more");

    // every step is on the record, in order
    const stages = lifecycle(server.output()).map((l) => l.stage);
    const expected = ["boot", "shutdown-started", "room-notice-sent", "room-closing-sockets", "room-disposed", "shutdown-finished", "process-exit"];
    const positions = expected.map((s) => stages.indexOf(s));
    assert.ok(positions.every((p) => p >= 0), `stages: ${stages.join(", ")}`);
    assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b), `stages: ${stages.join(", ")}`);
    assert.ok(stages.includes("signal-received"), "the signal is on the record");

    const notice = lifecycle(server.output()).find((l) => l.stage === "room-notice-sent") as unknown as {
      room: string;
      sockets: { session: string; readyState: number }[];
    };
    assert.strictEqual(notice.room, host.roomId);
    assert.deepStrictEqual(notice.sockets.map((s) => s.readyState), [1, 1], "both sockets open when the notice was sent");
  });

  it("a repeated SIGTERM changes nothing: one notice each, a clean exit", async () => {
    server = await startServer();
    const { players } = await twoPlayers();
    server.term();
    await new Promise((r) => setTimeout(r, 100));
    server.term();
    await within(Promise.all(players.map((p) => p.closed)), 15_000, "players closed");
    for (const { seen } of players) assert.strictEqual(seen.notices.length, 1, "exactly one notice");
    assert.strictEqual(await within(server.exited, 15_000, "process exit"), 0, server.output());
    const signals = lifecycle(server.output()).filter((l) => l.stage === "signal-received");
    assert.strictEqual(signals.length, 2, server.output());
    assert.strictEqual(lifecycle(server.output()).filter((l) => l.stage === "room-notice-sent").length, 1);
  });

  it("with nobody connected it exits at once", async () => {
    server = await startServer();
    const startedAt = Date.now();
    server.term();
    assert.strictEqual(await within(server.exited, 15_000, "process exit"), 0, server.output());
    assert.ok(Date.now() - startedAt < 3000, `took ${Date.now() - startedAt} ms`);
  });

  it("a restarted server has a new identity, and new rooms work", async () => {
    server = await startServer();
    const first = (await (await fetch(`${BASE}/health`)).json()) as { instance?: string };
    const old = await twoPlayers();
    const { serverInstance } = old.host.state as unknown as { serverInstance: string };
    assert.strictEqual(serverInstance, first.instance, "the room names the process holding it");
    server.term();
    assert.strictEqual(await within(server.exited, 15_000, "process exit"), 0);

    server = await startServer();
    const second = (await (await fetch(`${BASE}/health`)).json()) as { instance?: string };
    assert.ok(second.instance && second.instance !== first.instance, "a new process names itself differently");
    const again = await twoPlayers();
    const { serverInstance: now } = again.host.state as unknown as { serverInstance: string };
    assert.strictEqual(now, second.instance);
    for (const room of [again.host, again.guest]) {
      room.reconnection.enabled = false;
      void room.leave(true);
    }
  });

  // What Render runs: `npm run serve`, with the signal sent to npm. This proves
  // whether the signal reaches Node through npm; a real signal is needed, so it
  // cannot run on Windows.
  describe("through the production start command", () => {
    before(function () {
      if (process.platform === "win32") return this.skip();
      this.timeout(120_000);
      execSync("npm run build", { cwd: serverDir, stdio: "pipe" });
    });

    for (const how of ["npm-run-serve", "node-build"] as const) {
      it(`SIGTERM to the started process reaches Node and the players (${how})`, async () => {
        server = await startServer(how);
        const { players } = await twoPlayers();
        server.proc.kill("SIGTERM");
        await within(Promise.all(players.map((p) => p.closed)), 15_000, "players closed");
        for (const { seen } of players) {
          assert.strictEqual(seen.notices.length, 1, server.output());
          assert.strictEqual(seen.closeCode, SERVER_SHUTDOWN, server.output());
        }
        await within(server.exited, 15_000, "process exit");
        await new Promise((r) => setTimeout(r, 200));
        const stages = lifecycle(server.output()).map((l) => l.stage);
        assert.ok(stages.includes("signal-received"), `SIGTERM reached Node; stages: ${stages.join(", ")}`);
        assert.ok(stages.includes("process-exit"), `Node exited itself; stages: ${stages.join(", ")}`);
        await assert.rejects(fetch(`${BASE}/health`), "nothing listening any more");
      });
    }
  });
});
