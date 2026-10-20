// Two real clients against a real server: matchmaking over HTTP, then the
// room over WebSockets, exactly the path the browser will take.
import assert from "assert";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import type { Room as ClientRoom } from "@colyseus/sdk";

import appConfig from "../src/app.config.js";
import { CODE_ALPHABET, CODE_LENGTH } from "../src/rules.js";

type RosterRow = { id: string; name: string; ink: number; isHost: boolean; ready: boolean };
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

  before(async () => (colyseus = await boot(appConfig)));
  after(async () => colyseus.shutdown());
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
    assert.deepStrictEqual(s.players[h.sessionId], { id: h.sessionId, name: "Ada", ink: 0, isHost: true, ready: true });
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
    assert.deepStrictEqual(guest, { id: g.sessionId, name: "Grace", ink: 1, isHost: false, ready: false });
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

    let closed: number | undefined;
    g.onLeave((code) => (closed = code));
    sendUnchecked(g, "config", { map: "moon" });
    await eventually(() => closed !== undefined, "malformed sender disconnected");
    await eventually(() => Object.keys(snapshot(h).players).length === 1, "malformed sender removed");
    assert.strictEqual(snapshot(h).map, "district");
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
    });
  });

  it("serves a health endpoint", async () => {
    const res = await colyseus.http.get("/health");
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual((res.data as { status: string }).status, "ok");
  });
});
