// Two real clients against a real server: matchmaking over HTTP, then the
// room over WebSockets, exactly the path the browser will take.
import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import type { Room as ClientRoom } from "@colyseus/sdk";

import WebSocket from "ws";

import type appConfig from "../src/app.config.js";
import { testServer } from "./harness.js";
import { CODE_ALPHABET, CODE_LENGTH } from "../src/rules.js";
import type { MatchRoom, StartResult } from "../src/rooms/MatchRoom.js";

const PORT = 2568; // @colyseus/testing default
const BASE = `http://localhost:${PORT}`;
const ALLOWED = "http://localhost:5173"; // a development default
const FOREIGN = "https://evil.example";

type RosterRow = { id: string; name: string; ink: number; isHost: boolean; ready: boolean; connected: boolean };
type BodyRow = RosterRow & {
  spawned: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  moving: boolean;
  alive: boolean;
  weapon: string;
  epoch: number;
};

/** The lobby fields of a player row, without the body. */
const roster = (row: RosterRow | undefined) =>
  row && { id: row.id, name: row.name, ink: row.ink, isHost: row.isHost, ready: row.ready, connected: row.connected };
type MatchJSON = {
  code: string;
  phase: string;
  map: string;
  grapple: boolean;
  maxPlayers: number;
  hostId: string;
  players: Record<string, BodyRow>;
};

/** The room as this client sees it; empty until the first state arrives. */
function snapshot(room: ClientRoom): MatchJSON {
  const json = (room.state?.toJSON() ?? {}) as Partial<MatchJSON>;
  return { ...json, players: json.players ?? {} } as MatchJSON;
}

/** Send a payload the typed client would refuse, as a hostile client could. */
const sendUnchecked = (room: ClientRoom, type: string, message: unknown) =>
  (room.send as (type: string, message: unknown) => void)(type, message);

/** Close the socket without telling the server, as a reload or lost network does. */
async function drop(room: ClientRoom) {
  room.reconnection.enabled = false;
  await room.leave(false);
}

/** Ask the server to start; the reply says whether it did. */
const requestStart = (room: ClientRoom) => (room.request as (type: string) => Promise<StartResult>)("start");

/** Open a raw WebSocket with a chosen Origin: resolves "open" or the HTTP status that refused it. */
function upgrade(origin: string): Promise<"open" | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/`, { headers: { Origin: origin } });
    ws.on("open", () => {
      ws.terminate();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("error", reject);
  });
}

/** Wait for a condition that depends on a state patch arriving. */
async function eventually(check: () => boolean, what: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("match room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => colyseus.cleanup());

  async function host(options: Record<string, unknown> = {}) {
    const room = await colyseus.sdk.create("match", { name: "Ada", ...options });
    await eventually(() => Boolean(snapshot(room).code), "initial state");
    return room;
  }

  it("creates a room with a lobby-style code, owned by the host", async () => {
    const h = await host({ map: "valley", grapple: false });
    const s = snapshot(h);
    assert.strictEqual(s.code.length, CODE_LENGTH);
    assert.ok([...s.code].every((c) => CODE_ALPHABET.includes(c)), `code ${s.code} uses the lobby alphabet`);
    assert.strictEqual(h.roomId, s.code);
    assert.strictEqual(s.phase, "lobby");
    assert.strictEqual(s.map, "valley");
    assert.strictEqual(s.grapple, false);
    assert.strictEqual(s.maxPlayers, 4);
    assert.strictEqual(s.hostId, h.sessionId);
    assert.deepStrictEqual(roster(s.players[h.sessionId]), { id: h.sessionId, name: "Ada", ink: 0, isHost: true, ready: true, connected: true });
  });

  it("falls back to defaults for malformed options and clamps the player limit", async () => {
    const h = await host({ map: "moon", grapple: "yes", maxPlayers: 99, name: "  \u0007Ada-the-very-long-name  " });
    const s = snapshot(h);
    assert.strictEqual(s.map, "district");
    assert.strictEqual(s.grapple, true);
    assert.strictEqual(s.maxPlayers, 4);
    assert.strictEqual(s.players[h.sessionId].name, "Ada-the-very-lon");
  });

  it("lets a guest join by code; both clients see the same roster", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(h).players).length === 2, "host sees guest");
    await eventually(() => Object.keys(snapshot(g).players).length === 2, "guest sees host");

    const guest = snapshot(h).players[g.sessionId];
    assert.deepStrictEqual(roster(guest), { id: g.sessionId, name: "Grace", ink: 1, isHost: false, ready: false, connected: true });
    assert.deepStrictEqual(snapshot(g), snapshot(h));
  });

  it("rejects an unknown room code", async () => {
    await assert.rejects(colyseus.sdk.joinById("ZZZZ", { name: "Grace" }));
  });

  it("rejects a guest once the room is full", async () => {
    const h = await host({ maxPlayers: 2 });
    await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await assert.rejects(colyseus.sdk.joinById(h.roomId, { name: "Linus" }));
    assert.strictEqual(colyseus.getRoomById(h.roomId).clients.length, 2);
  });

  it("accepts ready flags from guests only", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(h).players).length === 2, "guest joined");

    g.send("ready", { ready: true });
    await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");

    h.send("ready", { ready: false });
    g.send("ready", { ready: false });
    await eventually(() => !snapshot(h).players[g.sessionId].ready, "guest unready");
    assert.strictEqual(snapshot(h).players[h.sessionId].ready, true, "the host is always ready");
  });

  it("applies valid match config from the host only", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(g).players).length === 2, "guest joined");

    g.send("config", { map: "tomb" });
    h.send("config", { map: "sanctuary", grapple: false });
    await eventually(() => snapshot(g).map === "sanctuary", "host config reaches guest");
    assert.strictEqual(snapshot(g).grapple, false);
  });

  it("disconnects a client that sends a malformed payload", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(h).players).length === 2, "guest joined");

    serverRoom(h.roomId).reconnectSeconds = 0.3;
    g.reconnection.enabled = false;

    let closed: number | undefined;
    g.onLeave((code) => (closed = code));
    sendUnchecked(g, "config", { map: "moon" });
    await eventually(() => closed !== undefined, "malformed sender disconnected");
    assert.strictEqual(snapshot(h).map, "district");
    // Held like any other drop, then released when nobody comes back with its token.
    await eventually(() => Object.keys(snapshot(h).players).length === 1, "malformed sender removed", 3000);
  });

  it("removes a guest who leaves", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(h).players).length === 2, "guest joined");

    await g.leave();
    await eventually(() => Object.keys(snapshot(h).players).length === 1, "guest removed");
    assert.strictEqual(snapshot(h).hostId, h.sessionId);
  });

  it("promotes the remaining guest when the host leaves", async () => {
    const h = await host();
    const g = await colyseus.sdk.joinById(h.roomId, { name: "Grace" });
    await eventually(() => Object.keys(snapshot(g).players).length === 2, "guest joined");

    await h.leave();
    await eventually(() => snapshot(g).hostId === g.sessionId, "guest promoted");
    assert.deepStrictEqual(roster(snapshot(g).players[g.sessionId]), {
      id: g.sessionId,
      name: "Grace",
      ink: 1,
      isHost: true,
      ready: true,
      connected: true,
    });
  });

  it("serves a health endpoint", async () => {
    const res = await colyseus.http.get("/health");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.data as { status: string }).status, "ok");
  });

  async function guest(h: ClientRoom, name = "Grace") {
    const g = await colyseus.sdk.joinById(h.roomId, { name });
    await eventually(() => Boolean(snapshot(h).players[g.sessionId]), `host sees ${name}`);
    await eventually(() => Boolean(snapshot(g).code), `${name} has state`);
    return g;
  }

  const serverRoom = (code: string) => colyseus.getRoomById<MatchRoom>(code);

  describe("starting a match", () => {
    it("starts only for the host, once every guest is ready", async () => {
      const h = await host();
      const g = await guest(h);

      assert.deepStrictEqual(await requestStart(g), { ok: false, reason: "not-host" });
      assert.deepStrictEqual(await requestStart(h), { ok: false, reason: "guests-not-ready" });
      assert.strictEqual(snapshot(h).phase, "lobby");

      g.send("ready", { ready: true });
      await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");
      assert.deepStrictEqual(await requestStart(h), { ok: true });
      await eventually(() => snapshot(g).phase === "playing", "guest sees the start");

      assert.deepStrictEqual(await requestStart(h), { ok: false, reason: "not-in-lobby" });
    });

    it("refuses to start an empty room", async () => {
      const h = await host();
      assert.deepStrictEqual(await requestStart(h), { ok: false, reason: "no-guests" });
      assert.strictEqual(serverRoom(h.roomId).state.phase, "lobby");
    });

    it("freezes lobby settings once playing and lets a late joiner see the running match", async () => {
      const h = await host();
      const g = await guest(h);
      g.send("ready", { ready: true });
      await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");
      assert.deepStrictEqual(await requestStart(h), { ok: true });

      h.send("config", { map: "tomb" });
      g.send("ready", { ready: false });
      const late = await guest(h, "Linus");
      assert.strictEqual(snapshot(late).phase, "playing");
      assert.strictEqual(snapshot(late).map, "district");
      assert.strictEqual(snapshot(late).players[g.sessionId].ready, true);
    });

    it("refuses to start while a guest is reconnecting", async () => {
      const h = await host();
      const g = await guest(h);
      g.send("ready", { ready: true });
      await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");

      await drop(g);
      await eventually(() => !snapshot(h).players[g.sessionId].connected, "guest marked as reconnecting");
      assert.deepStrictEqual(await requestStart(h), { ok: false, reason: "guest-reconnecting" });
    });
  });

  describe("reconnection", () => {
    it("gives a dropped guest the same seat back, with no duplicate", async () => {
      const h = await host();
      const g = await guest(h);
      g.send("ready", { ready: true });
      await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");
      const { sessionId, reconnectionToken } = g;

      await drop(g);
      await eventually(() => !snapshot(h).players[sessionId].connected, "seat held");
      assert.strictEqual(Object.keys(snapshot(h).players).length, 2);

      const back = await colyseus.sdk.reconnect(reconnectionToken);
      assert.strictEqual(back.sessionId, sessionId);
      await eventually(() => snapshot(h).players[sessionId].connected, "guest back");
      assert.strictEqual(Object.keys(snapshot(h).players).length, 2);
      assert.strictEqual(snapshot(h).players[sessionId].ready, true, "the seat keeps its ready flag");
    });

    it("frees the seat when the reconnection window expires", async () => {
      const h = await host();
      const g = await guest(h);
      serverRoom(h.roomId).reconnectSeconds = 0.3;
      const { sessionId, reconnectionToken } = g;

      await drop(g);
      await eventually(() => !snapshot(h).players[sessionId], "seat released", 3000);
      await assert.rejects(colyseus.sdk.reconnect(reconnectionToken));
      assert.strictEqual(Object.keys(snapshot(h).players).length, 1);
    });

    it("rejects a forged reconnection token", async () => {
      const h = await host();
      const g = await guest(h);
      await drop(g);
      await assert.rejects(colyseus.sdk.reconnect(`${h.roomId}:not-a-real-token`));
      assert.strictEqual(Object.keys(snapshot(h).players).length, 2);
    });

    it("lets the token's owner replace a stale socket without duplicating the seat", async () => {
      // A reload the server has not noticed yet: the old socket still looks
      // alive when the page comes back with its token.
      const h = await host();
      const g = await guest(h);
      g.reconnection.enabled = false;
      const { sessionId, reconnectionToken } = g;

      const back = await colyseus.sdk.reconnect(reconnectionToken);
      assert.strictEqual(back.sessionId, sessionId);
      await eventually(() => snapshot(h).players[sessionId]?.connected === true, "seat taken back");
      assert.strictEqual(Object.keys(snapshot(h).players).length, 2);
      assert.strictEqual(serverRoom(h.roomId).clients.length, 2);
    });

    it("never hands an existing seat to a fresh join", async () => {
      const h = await host();
      const g = await guest(h);
      const impostor = await colyseus.sdk.joinById(h.roomId, {
        name: "Grace",
        sessionId: g.sessionId,
        reconnectionToken: g.reconnectionToken,
      });
      assert.notStrictEqual(impostor.sessionId, g.sessionId);
      await eventually(() => Object.keys(snapshot(h).players).length === 3, "impostor seated separately");
      assert.strictEqual(snapshot(h).players[g.sessionId].connected, true);
      assert.strictEqual(snapshot(h).players[impostor.sessionId].isHost, false);
    });

    it("keeps a dropped host in charge until the window expires, then promotes a guest", async () => {
      const h = await host();
      const g = await guest(h);
      serverRoom(h.roomId).reconnectSeconds = 0.3;
      const hostId = h.sessionId;

      await drop(h);
      await eventually(() => !snapshot(g).players[hostId]?.connected, "host marked as reconnecting");
      assert.strictEqual(snapshot(g).hostId, hostId);
      await eventually(() => snapshot(g).hostId === g.sessionId, "guest promoted", 3000);
      assert.strictEqual(snapshot(g).players[g.sessionId].isHost, true);
    });
  });

  describe("player movement", () => {
    type MoveBody = {
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
      moving: boolean;
      alive: boolean;
      weapon: string;
      epoch: number;
    };
    const body = (over: Partial<MoveBody> = {}): MoveBody => ({
      x: 0,
      y: 0.2,
      z: 0,
      yaw: 0,
      pitch: 0,
      moving: false,
      alive: true,
      weapon: "RIFLE",
      epoch: 1,
      ...over,
    });
    const move = (room: ClientRoom, over: Partial<MoveBody> = {}) => room.send("move", body(over));
    const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** Host and guest, guest ready, match started. */
    async function playing() {
      const h = await host();
      const g = await guest(h);
      g.send("ready", { ready: true });
      await eventually(() => snapshot(h).players[g.sessionId].ready, "guest ready");
      assert.deepStrictEqual(await requestStart(h), { ok: true });
      await eventually(() => snapshot(g).phase === "playing", "playing");
      return { h, g };
    }

    it("ignores bodies before the match starts", async () => {
      const h = await host();
      const g = await guest(h);
      move(g, { x: 5 });
      await pause(150);
      assert.strictEqual(snapshot(h).players[g.sessionId].spawned, false);
      assert.strictEqual(serverRoom(h.roomId).state.players.get(g.sessionId)?.x, 0);
    });

    it("places a body on its first move and shows it to the other player", async () => {
      const { h, g } = await playing();
      assert.strictEqual(snapshot(h).players[g.sessionId].spawned, false, "nothing to draw before the first move");
      move(g, { x: 5, y: 1, z: -3, yaw: 1, pitch: 0.2, moving: true, weapon: "SNIPER" });
      await eventually(() => snapshot(h).players[g.sessionId].spawned, "host sees the guest's body");
      const b = snapshot(h).players[g.sessionId];
      assert.ok(close(b.x, 5) && close(b.y, 1) && close(b.z, -3), `at ${b.x},${b.y},${b.z}`);
      assert.ok(close(b.yaw, 1) && close(b.pitch, 0.2));
      assert.strictEqual(b.moving, true);
      assert.strictEqual(b.alive, true);
      assert.strictEqual(b.weapon, "SNIPER");
      assert.strictEqual(b.epoch, 1);
    });

    it("streams ordinary movement without changing the epoch", async () => {
      const { h, g } = await playing();
      move(g, { x: 0 });
      for (let i = 1; i <= 10; i++) {
        await pause(50);
        move(g, { x: i * 0.5, yaw: i * 0.1, moving: true });
      }
      await eventually(() => close(snapshot(h).players[g.sessionId].x, 5), "host sees the walk end");
      assert.ok(close(snapshot(h).players[g.sessionId].yaw, 1));
      assert.strictEqual(snapshot(h).players[g.sessionId].epoch, 1);
    });

    it("speed-limits a step that is too long", async () => {
      const { h, g } = await playing();
      move(g, { x: -50 });
      move(g, { x: 50 }); // 100 m in one packet, same epoch
      await pause(200);
      const x = snapshot(h).players[g.sessionId].x;
      assert.ok(x > -50 && x < 0, `went to x=${x}, not the claimed 50`);
    });

    it("accepts a teleport when the client stamps a new epoch", async () => {
      const { h, g } = await playing();
      move(g, { x: -50 });
      move(g, { x: 50, epoch: 2 });
      await eventually(() => close(snapshot(h).players[g.sessionId].x, 50), "teleported");
      assert.strictEqual(snapshot(h).players[g.sessionId].epoch, 2);
    });

    it("rate-limits teleports", async () => {
      const { h, g } = await playing();
      move(g, { x: -50 }); // placement: server epoch 1
      for (let e = 2; e <= 5; e++) move(g, { x: e % 2 ? -50 : 50, epoch: e }); // 4 teleports, 3 in the bank
      await pause(200);
      const b = serverRoom(h.roomId).state.players.get(g.sessionId)!;
      assert.strictEqual(b.epoch, 4, "three teleports accepted, the fourth refused");
      assert.ok(b.x > 0, `the refused teleport (to -50) only walked from +50: x=${b.x}`);
    });

    it("clamps bodies to the map and tidies angles and weapons", async () => {
      const { h, g } = await playing();
      move(g, { x: 500, y: -500, z: 0, yaw: 7, pitch: 3, weapon: "BAZOOKA" });
      await eventually(() => snapshot(h).players[g.sessionId].spawned, "placed");
      const b = snapshot(h).players[g.sessionId];
      assert.deepStrictEqual([b.x, b.y, b.z], [55, -8, 0]);
      assert.ok(close(b.yaw, 7 - Math.PI * 2), `yaw ${b.yaw}`);
      assert.ok(close(b.pitch, Math.PI / 2));
      assert.strictEqual(b.weapon, "RIFLE", "unknown weapon ignored");
      move(g, { x: 54, y: 0, z: 0, weapon: "KATANA" });
      await eventually(() => snapshot(h).players[g.sessionId].weapon === "KATANA", "known weapon applied");
    });

    it("disconnects a client that sends a malformed body, leaving everyone else as they were", async () => {
      const { h, g } = await playing();
      move(g, { x: 7 });
      await eventually(() => snapshot(h).players[g.sessionId].spawned, "guest placed");
      serverRoom(h.roomId).reconnectSeconds = 0.05;
      const bad: unknown[] = [
        { ...body(), x: Number.NaN },
        { ...body(), x: Number.POSITIVE_INFINITY },
        { ...body(), x: "5" },
        { ...body(), y: 1e9 },
        { ...body(), epoch: -1 },
        { ...body(), epoch: 1.5 },
        { ...body(), weapon: "X".repeat(64) },
        Object.fromEntries(Object.entries(body()).filter(([k]) => k !== "alive")),
        "not an object",
      ];
      for (const payload of bad) {
        const m = await guest(h, "Mallory");
        m.reconnection.enabled = false;
        let closed: number | undefined;
        m.onLeave((code) => (closed = code));
        sendUnchecked(m, "move", payload);
        await eventually(() => closed !== undefined, `kicked for ${JSON.stringify(payload)}`);
        await eventually(() => !snapshot(h).players[m.sessionId], "seat released");
      }
      const b = serverRoom(h.roomId).state.players.get(g.sessionId)!;
      assert.strictEqual(b.x, 7);
      assert.strictEqual(serverRoom(h.roomId).state.players.size, 2);
    });

    it("disconnects a client that floods the room", async () => {
      const { h, g } = await playing();
      g.reconnection.enabled = false;
      let closed: number | undefined;
      g.onLeave((code) => (closed = code));
      for (let i = 0; i < 200; i++) move(g, { x: i * 0.01 });
      await eventually(() => closed !== undefined, "flooder disconnected");
      assert.ok(snapshot(h).players[h.sessionId].connected);
    });

    it("removes a body when its player leaves", async () => {
      const { h, g } = await playing();
      move(g, { x: 3 });
      await eventually(() => snapshot(h).players[g.sessionId]?.spawned === true, "placed");
      await g.leave();
      await eventually(() => !snapshot(h).players[g.sessionId], "body gone");
      assert.strictEqual(Object.keys(snapshot(h).players).length, 1);
    });

    it("keeps one body through a reconnect and re-spawns it under a new epoch", async () => {
      const { h, g } = await playing();
      move(g, { x: 10 });
      await eventually(() => snapshot(h).players[g.sessionId]?.spawned === true, "placed");
      const { sessionId, reconnectionToken } = g;

      await drop(g);
      await eventually(() => snapshot(h).players[sessionId]?.connected === false, "dropped");
      move(h, { x: 1 }); // the room carries on meanwhile
      const back = await colyseus.sdk.reconnect(reconnectionToken);
      // a reloaded page runs a fresh engine: its epoch counter starts over
      back.send("move", body({ x: -40, epoch: 1 }));
      await eventually(() => close(snapshot(h).players[sessionId]?.x ?? 0, -40), "re-spawned where the new engine says");
      assert.strictEqual(snapshot(h).players[sessionId].epoch, 2, "viewers snap instead of sliding");
      assert.strictEqual(snapshot(h).players[sessionId].connected, true);
      assert.strictEqual(Object.keys(snapshot(h).players).length, 2);
    });
  });

  describe("origins", () => {
    const matchmake = (origin: string, method = "POST") =>
      fetch(`${BASE}/matchmake/create/match`, {
        method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ name: "Ada" }) : undefined,
      });

    it("names an allowed origin in CORS headers and creates the room", async () => {
      const preflight = await matchmake(ALLOWED, "OPTIONS");
      assert.strictEqual(preflight.headers.get("access-control-allow-origin"), ALLOWED);
      const res = await matchmake(ALLOWED);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("access-control-allow-origin"), ALLOWED);
      const body = (await res.json()) as { roomId?: string };
      assert.ok(body.roomId, "a seat was reserved");
    });

    it("refuses matchmaking from a foreign origin and omits CORS headers", async () => {
      const preflight = await matchmake(FOREIGN, "OPTIONS");
      assert.strictEqual(preflight.headers.get("access-control-allow-origin"), null);
      const res = await matchmake(FOREIGN);
      assert.notStrictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
      const body = (await res.json()) as { roomId?: string };
      assert.strictEqual(body.roomId, undefined);
    });

    it("refuses WebSocket upgrades from a foreign origin", async () => {
      assert.strictEqual(await upgrade(FOREIGN), 403);
      assert.notStrictEqual(await upgrade(ALLOWED), 403);
    });
  });
});
