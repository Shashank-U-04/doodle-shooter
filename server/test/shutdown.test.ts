// Graceful shutdown of the real server process: a platform stops the service
// with SIGTERM (redeploy, scale-down). Every room is disposed, every player is
// told the server is shutting down (close code 4001, not a dropped socket the
// SDK would keep retrying), and the process exits cleanly.
import assert from "assert";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@colyseus/sdk";

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

describe("graceful shutdown", function () {
  this.timeout(60_000);
  let child: ChildProcess | null = null;

  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    child = null;
  });

  it("on SIGTERM disposes rooms, tells players why, and exits 0", async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "test/fixtures/shutdown-child.ts"], {
      cwd: serverDir,
      // production: no dev-mode room caching; no .env files in the repo
      env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), ALLOWED_ORIGINS: "" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child = proc;
    let output = "";
    proc.stdout?.on("data", (d) => (output += d));
    proc.stderr?.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));
    // @colyseus/tools' listen() reports "ready" over IPC once it is listening
    await within(new Promise<void>((resolve) => proc.on("message", (m) => m === "ready" && resolve())), 30_000, "server ready");

    const health = await fetch(`${BASE}/health`);
    assert.strictEqual(health.status, 200);

    const client = new Client(BASE);
    const host = await client.create("match", { name: "Ada" });
    const guest = await client.joinById(host.roomId, { name: "Grace" });
    const leaveCode = (room: typeof host) => new Promise<number>((resolve) => room.onLeave((code) => resolve(code)));
    const hostLeft = leaveCode(host);
    const guestLeft = leaveCode(guest);

    if (process.platform === "win32") proc.send("SIGTERM");
    else proc.kill("SIGTERM");

    const codes = await within(Promise.all([hostLeft, guestLeft]), 15_000, "players told of the shutdown");
    assert.deepStrictEqual(codes, [SERVER_SHUTDOWN, SERVER_SHUTDOWN], output);
    assert.strictEqual(await within(exited, 15_000, "process exit"), 0, output);
    await assert.rejects(fetch(`${BASE}/health`), "nothing listening any more");
  });
});
