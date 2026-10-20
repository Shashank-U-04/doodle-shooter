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
type MatchJSON = {
  code: string;
  phase: string;
  map: string;
  grapple: boolean;
  maxPlayers: number;
  hostId: string;
  players: Record<string, RosterRow>;
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
    assert.deepStrictEqual(s.players[h.sessionId], { id: h.sessionId, name: "Ada", ink: 0, isHost: true, ready: true, connected: true });
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
    assert.deepStrictEqual(guest, { id: g.sessionId, name: "Grace", ink: 1, isHost: false, ready: false, connected: true });
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
    assert.deepStrictEqual(snapshot(g).players[g.sessionId], {
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
