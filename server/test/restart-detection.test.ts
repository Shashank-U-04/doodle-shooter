// Telling a restarted server from a network problem, with the real client session
// (src/game/colyseus.ts) and SDK against a real server, through a path whose
// faults the test controls. Everything here is a simulation of the hosting path:
// it proves the client's decisions, not what Render does.
//
// The server's own process is not restarted here (test/shutdown.test.ts does
// that): `reportInstance` makes /health answer as a different process would.
//
// Excluded from this package's `tsc` (it imports frontend code).
import assert from "assert";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import type { ColyseusTestServer } from "@colyseus/testing";
import type appConfig from "../src/app.config.js";
import { INSTANCE_ID } from "../src/lifecycle.js";
import type { MatchRoom } from "../src/rooms/MatchRoom.js";
import { testServer } from "./harness.js";
import { ColyseusSession } from "../../src/game/colyseus.js";
import { awaitInstanceVerdict, probeServerInstance, RestartWatch, type InstanceProbe } from "../../src/game/serverRestart.js";

const UPSTREAM = "http://localhost:2568"; // @colyseus/testing default
const RESTARTED = "The match server restarted, so this match has ended. Create or join a match again.";
const LOST = "Lost the connection to the match server and could not get back in. Join again.";
const PROBE_MS = 50;
/** pings unanswered this long count as a silent socket (6 s in the game) */
const SILENT_MS = 500;
/** how long a lost match may wait for /health's verdict (5 s in the game) */
const VERDICT_MS = 3000;

type Health = "pass" | "down" | "html" | "no-instance" | { instance: string };

class FaultyPath {
  url = "";
  /** while true: sockets and matchmaking are refused, as with the network down */
  down = false;
  health: Health = "pass";
  /** how long each /health answer is held back, ms (a slow host or proxy) */
  healthDelayMs = 0;
  /**
   * Pass the server's close codes on to the client. Off by default: like the
   * Render deployment, the path then turns every close the server starts into an
   * abnormal one.
   */
  forwardCloses = false;
  /** while true: open sockets stay open but carry nothing either way (no close) */
  muted = false;
  reconnectRequests = 0;
  healthRequests = 0;
  private server: Server | null = null;
  private wss = new WebSocketServer({ noServer: true });

  async open() {
    this.server = createServer(async (req, res) => {
      if (req.url?.startsWith("/health")) {
        this.healthRequests++;
        if (this.healthDelayMs > 0) await pause(this.healthDelayMs);
        if (this.health === "down") return void req.socket.destroy();
        if (this.health === "html") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>Sign in to Wi-Fi</html>");
        if (this.health === "no-instance") return void res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok","uptime":1}');
        if (this.health !== "pass") {
          return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", uptime: 1, instance: this.health.instance }));
        }
      } else if (this.down) {
        return void req.socket.destroy();
      }
      if (req.url?.startsWith("/matchmake/reconnect")) this.reconnectRequests++;
      const body = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      });
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([k, v]) => typeof v === "string" && !["host", "connection", "content-length"].includes(k)),
      ) as Record<string, string>;
      const upstream = await fetch(`${UPSTREAM}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url && req.url.includes("reconnectionToken")) this.reconnectRequests++;
      this.wss.handleUpgrade(req, socket, head, (client) => {
        // Network down: the attempt dies at once. Not by refusing the upgrade: Node's
        // built-in WebSocket then fires no `close`, so the SDK would wait for good.
        // Browsers do fire it (the browser tests cover a refused socket).
        if (this.down) return void client.terminate();
        const upstream = new WebSocket(`${UPSTREAM.replace(/^http/, "ws")}${req.url}`);
        const pending: { data: Buffer; binary: boolean }[] = [];
        upstream.on("open", () => {
          for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary });
        });
        upstream.on("message", (data: Buffer, binary) => !this.muted && client.readyState === WebSocket.OPEN && client.send(data, { binary }));
        upstream.on("close", (code, reason) => {
          // 1005/1006 cannot be sent in a close frame
          if (this.forwardCloses && code >= 1000 && code !== 1005 && code !== 1006) client.close(code, reason);
          else client.terminate();
        });
        upstream.on("error", () => client.terminate());
        client.on("message", (data: Buffer, binary) => {
          if (this.muted) return;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else pending.push({ data, binary });
        });
        client.on("close", () => upstream.terminate());
        client.on("error", () => upstream.terminate());
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Every socket dies abnormally, with nothing delivered: no notice, no close. */
  cut() {
    for (const c of this.wss.clients) c.terminate();
  }

  close() {
    return new Promise<void>((r) => {
      for (const c of this.wss.clients) c.terminate();
      this.server?.close(() => r());
      this.server?.closeAllConnections();
    });
  }
}

async function eventually(check: () => boolean, what: string, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SdkRoom = { reconnection: { minUptime: number; maxRetries: number; maxDelay: number; isReconnecting: boolean }; sessionId: string };
const roomOf = (s: ColyseusSession) => (s as unknown as { room: SdkRoom | null }).room;

describe("telling a server restart from a network problem", function () {
  this.timeout(30_000);
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let path: FaultyPath;
  const sessions: ColyseusSession[] = [];

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    path = await new FaultyPath().open();
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close();
    await path.close();
  });

  type Tracked = { session: ColyseusSession; lost: string[]; errors: string[]; statuses: string[] };

  function open(code: string, name: string, isHost: boolean): Tracked {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const session = new ColyseusSession(
      code,
      name,
      isHost,
      { map: "district", grapple: true },
      { url: path.url, storage, restartProbeMs: PROBE_MS, silentSocketMs: SILENT_MS, restartVerdictMs: VERDICT_MS },
    );
    sessions.push(session);
    const lost: string[] = [];
    const errors: string[] = [];
    const statuses: string[] = [];
    session.setHandlers({ onLost: (t) => lost.push(t), onError: (t) => errors.push(t), onStatus: (t) => statuses.push(t) });
    session.connect();
    return { session, lost, errors, statuses };
  }

  /**
   * The process holding the room goes away under both players and a new one
   * takes its place: the sockets die, the room is gone, and (once `down` is
   * cleared) a reconnect reaches a server that has never heard of the room.
   */
  async function roomGoneWithItsProcess(host: Tracked, guest: Tracked) {
    for (const p of [host, guest]) {
      const r = roomOf(p.session)!.reconnection;
      r.maxDelay = 100; // reconnect attempts well inside the slow /health answer
      r.maxRetries = 1000; // and never give up on their own while the path is down
    }
    path.down = true;
    path.health = "down";
    path.cut();
    await eventually(() => path.healthRequests >= 2, "the client asks while the path is down");
    await colyseus.getRoomById<MatchRoom>(host.session.code).disconnect();
    // the new process refuses the reconnect with a real close code (4003)
    path.forwardCloses = true;
  }

  /** A host and a guest in one room, allowed to reconnect straight away. */
  async function twoPlayers() {
    const host = open("", "Ada", true);
    await eventually(() => host.session.joined && host.session.code.length === 4, "host in");
    const guest = open(host.session.code, "Grace", false);
    await eventually(() => guest.session.joined && host.session.getPlayers().length === 2, "both in");
    for (const p of [host, guest]) roomOf(p.session)!.reconnection.minUptime = 0;
    return { host, guest };
  }

  it("a new process on /health, and no notice or close at all: both told at once, once, with the exact text", async () => {
    const { host, guest } = await twoPlayers();
    path.health = { instance: "a-new-process" };
    const startedAt = Date.now();
    path.cut();
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told", 2000);
    assert.ok(Date.now() - startedAt < 2000, `took ${Date.now() - startedAt} ms`);
    for (const p of [host, guest]) {
      assert.deepStrictEqual(p.lost, [RESTARTED]);
      assert.strictEqual(roomOf(p.session), null, "the session let its room go");
    }
    // nothing further: no second message, and the retries have stopped
    await pause(1500);
    const before = path.reconnectRequests;
    await pause(1500);
    assert.strictEqual(path.reconnectRequests, before, "no more reconnection attempts");
    for (const p of [host, guest]) assert.deepStrictEqual(p.lost, [RESTARTED], "still only one message");
  });

  it("a short interruption with the same process: reconnected, same seat, no message", async () => {
    const { host, guest } = await twoPlayers();
    const seat = guest.session.me;
    path.down = true;
    path.health = "down";
    path.cut();
    await eventually(() => guest.statuses.includes("CONNECTION DROPPED — RECONNECTING…"), "the guest sees the drop");
    await pause(800);
    assert.deepStrictEqual(guest.lost, [], "network down: no verdict");
    path.down = false;
    path.health = "pass";
    await eventually(() => guest.statuses.includes("RECONNECTED"), "the guest is back", 15_000);
    assert.strictEqual(guest.session.me, seat, "same seat");
    assert.deepStrictEqual(guest.lost, []);
    assert.deepStrictEqual(host.lost, []);
    const server = colyseus.getRoomById<MatchRoom>(host.session.code);
    assert.strictEqual(server.state.players.size, 2, "no duplicate seat");
    // and the watch has stopped
    await pause(PROBE_MS * 3);
    const asked = path.healthRequests;
    await pause(PROBE_MS * 6);
    assert.strictEqual(path.healthRequests, asked, "no more checks once reconnected");
  });

  it("sockets lost but /health still names the same process: keeps reconnecting, no message", async () => {
    const { host, guest } = await twoPlayers();
    path.cut();
    await eventually(() => host.statuses.includes("RECONNECTED") && guest.statuses.includes("RECONNECTED"), "both back", 15_000);
    assert.deepStrictEqual(host.lost, []);
    assert.deepStrictEqual(guest.lost, []);
    assert.ok(path.healthRequests > 0, "the server was asked");
  });

  it("server unavailable during the reconnect: no verdict until a new process actually answers", async () => {
    const { host, guest } = await twoPlayers();
    path.down = true;
    path.health = "down";
    path.cut();
    await eventually(() => path.healthRequests >= 4, "the client keeps asking");
    assert.deepStrictEqual(host.lost, []);
    assert.deepStrictEqual(guest.lost, []);
    // the replacement comes up
    path.down = false;
    path.health = { instance: "a-new-process" };
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told");
    assert.deepStrictEqual(host.lost, [RESTARTED]);
    assert.deepStrictEqual(guest.lost, [RESTARTED]);
  });

  it("a long interruption: the seat expires and the message says so, never a restart", async () => {
    const { host, guest } = await twoPlayers();
    colyseus.getRoomById<MatchRoom>(host.session.code).reconnectSeconds = 1;
    const room = roomOf(guest.session)!;
    room.reconnection.maxRetries = 3;
    room.reconnection.maxDelay = 500;
    roomOf(host.session)!.reconnection.maxRetries = 3;
    roomOf(host.session)!.reconnection.maxDelay = 500;
    path.down = true;
    path.health = "down";
    path.cut();
    await pause(1500); // past the hold: both seats are gone
    path.down = false;
    path.health = "pass";
    await eventually(() => guest.lost.length > 0 && host.lost.length > 0, "both give up", 15_000);
    assert.deepStrictEqual(guest.lost, [LOST]);
    assert.deepStrictEqual(host.lost, [LOST]);
  });

  it("an older server that does not name itself: no verdict from /health", async () => {
    const { host } = await twoPlayers();
    path.health = "no-instance";
    path.cut();
    await eventually(() => host.statuses.includes("RECONNECTED"), "back", 15_000);
    assert.deepStrictEqual(host.lost, []);
  });

  it("a captive portal answering /health: no verdict", async () => {
    const { host } = await twoPlayers();
    path.down = true;
    path.health = "html";
    path.cut();
    await eventually(() => path.healthRequests >= 4, "the client keeps asking");
    assert.deepStrictEqual(host.lost, []);
    path.down = false;
    path.health = "pass";
    await eventually(() => host.statuses.includes("RECONNECTED"), "back", 15_000);
    assert.deepStrictEqual(host.lost, []);
  });

  it("the notice and the socket's death together: one message", async () => {
    const { host, guest } = await twoPlayers();
    path.health = { instance: "a-new-process" };
    colyseus.getRoomById<MatchRoom>(host.session.code).onBeforeShutdown();
    path.cut();
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told", 2000);
    await pause(500);
    assert.deepStrictEqual(host.lost, [RESTARTED]);
    assert.deepStrictEqual(guest.lost, [RESTARTED]);
  });

  it("LEAVE during a reconnect stops the checks", async () => {
    const { guest } = await twoPlayers();
    path.down = true;
    path.health = "down";
    path.cut();
    await eventually(() => path.healthRequests >= 2, "asking");
    guest.session.close();
    await pause(PROBE_MS * 3);
    path.health = { instance: "a-new-process" };
    await pause(PROBE_MS * 6);
    assert.deepStrictEqual(guest.lost, [], "left on purpose: no message");
  });

  it("a reconnect reaches the new process before /health confirms it: told it restarted, once, not 'lost'", async () => {
    const { host, guest } = await twoPlayers();
    await roomGoneWithItsProcess(host, guest);
    path.healthDelayMs = 1000; // /health answers well after the refused reconnect
    path.health = { instance: "a-new-process" };
    const refusedBefore = path.reconnectRequests;
    path.down = false;
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told", 8000);
    assert.ok(path.reconnectRequests > refusedBefore, "a reconnect reached the new process first");
    await pause(1500); // the watch's own late answer, and any stray retry, change nothing
    for (const p of [host, guest]) {
      assert.deepStrictEqual(p.lost, [RESTARTED]);
      assert.deepStrictEqual(p.errors, [RESTARTED], "one notification, no conflicting one");
    }
  });

  it("/health fails at first, then names a new process: told it restarted, not 'lost'", async () => {
    const { host, guest } = await twoPlayers();
    await roomGoneWithItsProcess(host, guest);
    const refusedBefore = path.reconnectRequests;
    path.down = false; // reconnects reach the new process; /health still fails
    await eventually(() => path.reconnectRequests > refusedBefore, "a reconnect reaches the new process");
    await pause(300);
    assert.deepStrictEqual(host.lost, [], "no verdict yet while /health gives no answer");
    assert.deepStrictEqual(guest.lost, [], "no verdict yet while /health gives no answer");
    path.health = { instance: "a-new-process" };
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told", VERDICT_MS + 2000);
    for (const p of [host, guest]) {
      assert.deepStrictEqual(p.lost, [RESTARTED]);
      assert.deepStrictEqual(p.errors, [RESTARTED]);
    }
  });

  it("a silent socket (no close event) and a new process on /health: told without waiting for a close", async () => {
    const { host, guest } = await twoPlayers();
    path.health = { instance: "a-new-process" };
    path.muted = true;
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both told", 8000);
    await pause(500);
    for (const p of [host, guest]) {
      assert.deepStrictEqual(p.lost, [RESTARTED]);
      assert.deepStrictEqual(p.errors, [RESTARTED]);
      assert.strictEqual(roomOf(p.session), null, "the session let its room go");
    }
  });

  it("a silent socket on the same process: no verdict, and the checks stop once it answers again", async () => {
    const { host, guest } = await twoPlayers();
    path.muted = true;
    await eventually(() => path.healthRequests >= 4, "the client asks the server", 8000);
    path.muted = false;
    await pause(2600); // the next ping (every 2 s) is answered
    const asked = path.healthRequests;
    await pause(PROBE_MS * 6);
    assert.strictEqual(path.healthRequests, asked, "no more checks once pongs are back");
    assert.deepStrictEqual(host.lost, []);
    assert.deepStrictEqual(guest.lost, []);
    assert.ok(host.session.joined && guest.session.joined, "both still in the match");
  });

  it("the network down until the SDK gives up: 'lost', never 'restarted'", async () => {
    const { host, guest } = await twoPlayers();
    for (const p of [host, guest]) {
      roomOf(p.session)!.reconnection.maxRetries = 3;
      roomOf(p.session)!.reconnection.maxDelay = 100;
    }
    path.down = true;
    path.health = "down";
    path.cut();
    await eventually(() => host.lost.length > 0 && guest.lost.length > 0, "both give up", VERDICT_MS + 10_000);
    for (const p of [host, guest]) {
      assert.deepStrictEqual(p.lost, [LOST]);
      assert.deepStrictEqual(p.errors, [LOST]);
    }
  });

  it("the room really does name this server process, and so does /health", async () => {
    const { host } = await twoPlayers();
    const state = colyseus.getRoomById<MatchRoom>(host.session.code).state;
    assert.strictEqual(state.serverInstance, INSTANCE_ID);
    const health = (await (await fetch(`${path.url}/health`)).json()) as { instance?: string };
    assert.strictEqual(health.instance, INSTANCE_ID);
  });

  describe("probeServerInstance", () => {
    it("only a clear answer naming another process counts as a change", async () => {
      path.health = "pass";
      assert.strictEqual(await probeServerInstance(path.url, INSTANCE_ID), "same");
      assert.strictEqual(await probeServerInstance(path.url.replace(/^http/, "ws"), INSTANCE_ID), "same", "a ws:// URL works too");
      assert.strictEqual(await probeServerInstance(path.url, "another"), "changed");
      for (const health of ["down", "html", "no-instance"] as const) {
        path.health = health;
        assert.strictEqual(await probeServerInstance(path.url, INSTANCE_ID), "no-evidence", health);
      }
    });

    it("a hung server is no evidence, and does not hang the check", async () => {
      const silent = createServer(() => {});
      await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
      const { port } = silent.address() as AddressInfo;
      assert.strictEqual(await probeServerInstance(`http://127.0.0.1:${port}`, INSTANCE_ID, 100), "no-evidence");
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    });

    it("works without AbortSignal.timeout (Safari before 16), and still times out", async () => {
      const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
      Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });
      const silent = createServer(() => {});
      try {
        path.health = "pass";
        assert.strictEqual(await probeServerInstance(path.url, INSTANCE_ID), "same");
        assert.strictEqual(await probeServerInstance(path.url, "another"), "changed");
        await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
        const { port } = silent.address() as AddressInfo;
        const startedAt = Date.now();
        assert.strictEqual(await probeServerInstance(`http://127.0.0.1:${port}`, INSTANCE_ID, 150), "no-evidence");
        const took = Date.now() - startedAt;
        assert.ok(took >= 100 && took < 2000, `gave up after ${took} ms, not at the 150 ms timeout`);
      } finally {
        if (original) Object.defineProperty(AbortSignal, "timeout", original);
        silent.closeAllConnections();
        await new Promise((r) => silent.close(r));
      }
    });
  });

  describe("awaitInstanceVerdict", () => {
    it("stops at the first clear answer, at the deadline, or when cancelled", async () => {
      const answers = (...list: InstanceProbe[]) => {
        let calls = 0;
        const probe = async () => list[Math.min(calls++, list.length - 1)];
        return { probe, calls: () => calls };
      };
      const clear = answers("no-evidence", "no-evidence", "changed", "same");
      assert.strictEqual(await awaitInstanceVerdict(clear.probe, { waitMs: 1000, everyMs: 1 }), "changed");
      assert.strictEqual(clear.calls(), 3);

      const never = answers("no-evidence");
      const startedAt = Date.now();
      assert.strictEqual(await awaitInstanceVerdict(never.probe, { waitMs: 100, everyMs: 10 }), "no-evidence");
      assert.ok(Date.now() - startedAt < 500, "gave up at the deadline");

      let stop = false;
      const cancelled = answers("no-evidence");
      const pending = awaitInstanceVerdict(cancelled.probe, { waitMs: 10_000, everyMs: 10, cancelled: () => stop });
      await pause(35);
      stop = true;
      assert.strictEqual(await pending, "no-evidence");
      const asked = cancelled.calls();
      await pause(50);
      assert.strictEqual(cancelled.calls(), asked, "no more questions once cancelled");
    });
  });

  describe("RestartWatch", () => {
    it("fires once, runs one probe at a time, and stops when told", async () => {
      let inFlight = 0;
      let most = 0;
      let calls = 0;
      let fired = 0;
      const watch = new RestartWatch(
        async () => {
          inFlight++;
          most = Math.max(most, inFlight);
          await pause(20);
          inFlight--;
          return ++calls >= 3 ? "changed" : "no-evidence";
        },
        () => fired++,
        1,
      );
      watch.start();
      watch.start(); // a second drop while watching
      await eventually(() => fired > 0, "the change is reported");
      await pause(60);
      assert.strictEqual(fired, 1);
      assert.strictEqual(calls, 3);
      assert.strictEqual(most, 1);

      const stopped = new RestartWatch(async () => "changed", () => fired++, 1);
      stopped.start();
      stopped.stop();
      await pause(30);
      assert.strictEqual(fired, 1, "stopped before the answer: nothing fires");
    });
  });
});
