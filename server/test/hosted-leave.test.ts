// Leaving a room through a hosting path that loses server-initiated closes.
//
// On 2026-10-24, socket traces against the Render deployment showed that every
// WebSocket close the *server* starts (a consented LEAVE, a validation kick)
// never reaches the client: the client sees nothing, then an abnormal 1006
// about 20 s later. A close the *client* starts completes in one round trip.
// The same server build, run locally on the same Node version, closes cleanly
// every time, so the loss is in the hosting path.
//
// Colyseus' consented leave relies on the server's close (code 4000). Through
// that path the SDK saw 1006, took it for a dropped connection and spent about
// a minute reconnecting to a seat the server had already removed.
//
// `lossyProxy` reproduces the path: it forwards HTTP and WebSocket traffic, but
// a close from the server is not passed on; the client's connection is torn
// down a little later instead. Closes from the client are forwarded normally.
//
// Excluded from this package's `tsc` (it imports frontend code).
import assert from "assert";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import type { ColyseusTestServer } from "@colyseus/testing";
import { Client } from "@colyseus/sdk";
import { matchMaker } from "colyseus";
import type appConfig from "../src/app.config.js";
import type { MatchRoom } from "../src/rooms/MatchRoom.js";
import { testServer } from "./harness.js";
import { ColyseusSession, leaveRoom } from "../../src/game/colyseus.js";

const UPSTREAM = "http://localhost:2568"; // @colyseus/testing default
/** How long the fake hosting path keeps a client socket alive after losing the server's close (Render: ~20 s). */
const DROP_AFTER_MS = 1500;
const CONSENTED = 4000;

type Proxy = { url: string; upgrades: number; reconnectRequests: number; close(): Promise<void> };

async function lossyProxy(): Promise<Proxy> {
  const stats = { upgrades: 0, reconnectRequests: 0 };
  const wss = new WebSocketServer({ noServer: true });
  const server: Server = createServer(async (req, res) => {
    if (req.url?.startsWith("/matchmake/reconnect")) stats.reconnectRequests++;
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

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    stats.upgrades++;
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`${UPSTREAM.replace(/^http/, "ws")}${req.url}`);
      const pending: { data: Buffer; binary: boolean }[] = [];
      upstream.on("open", () => {
        for (const m of pending.splice(0)) upstream.send(m.data, { binary: m.binary });
      });
      upstream.on("message", (data: Buffer, binary) => client.readyState === WebSocket.OPEN && client.send(data, { binary }));
      // the server closed: the frame is lost; the client's socket dies later, abnormally (1006)
      upstream.on("close", () => setTimeout(() => client.terminate(), DROP_AFTER_MS));
      client.on("message", (data: Buffer, binary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        else pending.push({ data, binary });
      });
      // the client closed: forwarded as usual (and `ws` answers the client's close frame)
      client.on("close", (code) => {
        const forward = code >= 1000 && code !== 1005 && code !== 1006 ? code : undefined;
        if (upstream.readyState === WebSocket.OPEN) upstream.close(forward);
        else upstream.once("open", () => upstream.close(forward));
      });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get upgrades() {
      return stats.upgrades;
    },
    get reconnectRequests() {
      return stats.reconnectRequests;
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

async function eventually(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real client session (src/game/colyseus.ts) talking through the proxy. */
function session(url: string, code: string, name: string, isHost: boolean) {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const s = new ColyseusSession(code, name, isHost, { map: "district", grapple: true }, { url, storage });
  s.connect();
  return s;
}
type SdkRoom = { onLeave(cb: (code: number) => void): void; reconnection: { isReconnecting: boolean } };
const roomOf = (s: ColyseusSession) => (s as unknown as { room: SdkRoom | null }).room;

describe("leaving through a hosting path that loses server-initiated closes", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  let proxy: Proxy;
  const sessions: ColyseusSession[] = [];

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    proxy = await lossyProxy();
  });
  afterEach(async () => {
    for (const s of sessions.splice(0)) s.close();
    await proxy.close();
  });

  const open = (code: string, name: string, isHost: boolean) => {
    const s = session(proxy.url, code, name, isHost);
    sessions.push(s);
    return s;
  };

  it("reproduces the fault: the SDK's own leave gets no close, then an abnormal 1006", async () => {
    const room = await new Client(proxy.url).create("match", { name: "CONTROL" });
    room.reconnection.enabled = false;
    const closes: number[] = [];
    room.onLeave((code) => closes.push(code));
    void room.leave(true);
    await pause(DROP_AFTER_MS - 300);
    assert.deepStrictEqual(closes, [], "no close arrives while the path holds the socket");
    await eventually(() => closes.length > 0, "the path drops the socket", DROP_AFTER_MS + 2000);
    assert.strictEqual(closes[0], 1006);
  });

  it("leaveRoom completes at once with CONSENTED, and the server took it as a leave", async () => {
    const room = await new Client(proxy.url).create("match", { name: "FIXED" });
    const started = Date.now();
    const code = await leaveRoom(room);
    assert.strictEqual(code, CONSENTED);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
    await eventually(() => colyseus.getRoomById(room.roomId) === undefined, "the room is gone (it was the only player)");
  });

  it("a player who leaves is gone for everyone at once: no held seat, no reconnecting", async () => {
    const host = open("", "Ada", true);
    await eventually(() => host.joined && host.code.length === 4, "host room open");
    const guest = open(host.code, "Grace", false);
    await eventually(() => guest.joined && host.getPlayers().length === 2, "both in the room");
    const server = colyseus.getRoomById<MatchRoom>(host.code);

    const guestRoom = roomOf(guest)!;
    const closes: number[] = [];
    guestRoom.onLeave((code) => closes.push(code));
    const upgradesBefore = proxy.upgrades;
    guest.close();

    await eventually(() => closes.length > 0, "the guest's socket closed", 1000);
    assert.deepStrictEqual(closes, [CONSENTED]);
    // removed, not held for a reconnection (a held seat stays in the roster as connected: false)
    await eventually(() => server.state.players.size === 1, "the guest's seat is released", 1000);
    await eventually(() => host.getPlayers().length === 1, "the host's roster shows one player", 1000);
    // past the moment the path would have dropped the socket: nothing comes back
    await pause(DROP_AFTER_MS + 1000);
    assert.strictEqual(guestRoom.reconnection.isReconnecting, false);
    assert.strictEqual(proxy.reconnectRequests, 0, "no reconnection attempts");
    assert.strictEqual(proxy.upgrades, upgradesBefore, "no new sockets");
    assert.strictEqual(server.state.players.size, 1);
  });

  it("leaving and rejoining by code gives one seat per player, and no ghosts", async () => {
    const host = open("", "Ada", true);
    await eventually(() => host.joined && host.code.length === 4, "host room open");
    const first = open(host.code, "Grace", false);
    await eventually(() => first.joined && host.getPlayers().length === 2, "guest in");
    first.close();
    await eventually(() => host.getPlayers().length === 1, "guest out");

    const again = open(host.code, "Grace", false);
    await eventually(() => again.joined && host.getPlayers().length === 2, "guest back in");
    const server = colyseus.getRoomById<MatchRoom>(host.code);
    const names = [...server.state.players.values()].map((p) => `${p.name}:${p.connected}`).sort();
    assert.deepStrictEqual(names, ["Ada:true", "Grace:true"]);
    await pause(DROP_AFTER_MS + 500);
    assert.strictEqual(server.state.players.size, 2, "still exactly two after the old socket would have dropped");
  });

  it("the last player leaving closes the room", async () => {
    const host = open("", "Ada", true);
    await eventually(() => host.joined && host.code.length === 4, "host room open");
    const code = host.code;
    host.close();
    await eventually(() => colyseus.getRoomById(code) === undefined, "room disposed", 1000);
    assert.deepStrictEqual(
      (await matchMaker.query({ name: "match" })).map((r) => r.roomId),
      [],
    );
    await pause(DROP_AFTER_MS + 500);
    assert.strictEqual(proxy.reconnectRequests, 0);
  });
});
