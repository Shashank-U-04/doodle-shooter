// Who can get into a room, and how many rooms anyone can make.
//
// A room's code is the only thing that keeps strangers out, so the only ways
// in are `create` (a new room of your own) and `joinById` (a code you were
// given), plus `reconnect` with your own seat's token. Colyseus also exposes
// `join` and `joinOrCreate`, which seat the caller in *any* open room.
import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import type appConfig from "../src/app.config.js";
import { matchMaker } from "colyseus";
import { testServer } from "./harness.js";
import { roomLimiter } from "../src/rooms/MatchRoom.js";
import { DEFAULT_ROOM_LIMITS } from "../src/limits.js";

const PORT = 2568; // @colyseus/testing default
const BASE = `http://localhost:${PORT}`;
const ALLOWED = "http://localhost:5173";

/** A raw matchmaking call, as any HTTP client could make it. */
const matchmake = (method: string, room: string, body: unknown = {}) =>
  fetch(`${BASE}/matchmake/${method}/${room}`, {
    method: "POST",
    headers: { Origin: ALLOWED, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("room access", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => (colyseus = await testServer()));
  beforeEach(async () => colyseus.cleanup());

  it("a stranger cannot be seated in an open room without its code", async () => {
    const host = await colyseus.sdk.create("match", { name: "Ada" });
    const rooms = async () => (await matchMaker.query({ name: "match" })).length;
    assert.strictEqual(await rooms(), 1);

    for (const method of ["join", "joinOrCreate"]) {
      const res = await matchmake(method, "match", { name: "Eve" });
      assert.ok(res.status >= 400, `${method} answered ${res.status}`);
    }
    // nobody joined, and joinOrCreate did not make a room either
    assert.strictEqual(await rooms(), 1);
    const room = colyseus.getRoomById(host.roomId);
    assert.strictEqual(room.clients.length, 1);

    // the code still works
    const guest = await colyseus.sdk.joinById(host.roomId, { name: "Bob" });
    assert.strictEqual(guest.roomId, host.roomId);
  });

  describe("room-creation limits", () => {
    afterEach(() => roomLimiter.configure(GENEROUS));

    it("refuses with 429 once an address has used its budget", async () => {
      roomLimiter.configure({ ...DEFAULT_ROOM_LIMITS, createsPerIpPerMinute: 2 });
      const created = [await matchmake("create", "match"), await matchmake("create", "match")];
      assert.deepStrictEqual(created.map((r) => r.status), [200, 200]);
      const refused = await matchmake("create", "match");
      assert.strictEqual(refused.status, 429);
      assert.match(JSON.stringify(await refused.json()), /wait a minute/);
      // joining is not creating: still allowed
      const host = await colyseus.sdk.joinById((await matchMaker.query({ name: "match" }))[0].roomId, { name: "Bob" });
      assert.ok(host.roomId);
    });

    it("refuses at the live-room ceiling", async () => {
      roomLimiter.configure({ ...GENEROUS, maxRooms: 1 });
      assert.strictEqual((await matchmake("create", "match")).status, 200);
      const refused = await matchmake("create", "match");
      assert.strictEqual(refused.status, 429);
      assert.match(JSON.stringify(await refused.json()), /full/);
    });
  });
});

/** What the rest of the suite runs with (harness.ts): it creates a room per test. */
const GENEROUS = { maxRooms: 10_000, createsPerMinute: 1_000_000, createsPerIpPerMinute: 1_000_000 };
