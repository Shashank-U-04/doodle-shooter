import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import type appConfig from "../src/app.config.js";
import { Metrics, metrics, quantile } from "../src/metrics.js";
import { roomStats } from "../src/rooms/MatchRoom.js";
import { testServer } from "./harness.js";

const MEMORY = { rss: 80 * 2 ** 20, heapUsed: 30 * 2 ** 20 };

describe("metrics", () => {
  it("quantiles are nearest-rank", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.strictEqual(quantile(xs, 0.5), 5);
    assert.strictEqual(quantile(xs, 0.95), 10);
    assert.strictEqual(quantile([], 0.5), 0);
    assert.strictEqual(quantile([7], 0.99), 7);
  });

  it("stays quiet when nothing happened, and reports a window when something did", () => {
    let now = 0;
    const m = new Metrics(() => now);
    assert.strictEqual(m.flush(0, 0, MEMORY), null);

    for (let i = 1; i <= 100; i++) m.tick(i / 100); // 0.01 … 1.00 ms
    m.createRefused();
    m.roomCreated();
    now = 60_000;
    const line = m.flush(2, 5, MEMORY)!;
    assert.deepStrictEqual(
      { ...line },
      {
        event: "metrics",
        windowS: 60,
        rooms: 2,
        players: 5,
        ticks: 100,
        tickP50Ms: 0.5,
        tickP95Ms: 0.95,
        tickP99Ms: 0.99,
        tickMaxMs: 1,
        createsRefused: 1,
        roomsCreated: 1,
        roomsDisposed: 0,
        rssMb: 80,
        heapUsedMb: 30,
      },
    );
    // the next window starts empty
    now = 120_000;
    assert.strictEqual(m.flush(0, 0, MEMORY), null);
  });

  it("keeps a bounded sample, and the maximum exactly", () => {
    const m = new Metrics(() => 0);
    for (let i = 0; i < 100_000; i++) m.tick(i === 77_777 ? 50 : 0.1);
    const line = m.flush(1, 2, MEMORY)!;
    assert.strictEqual(line.ticks, 100_000);
    assert.strictEqual(line.tickMaxMs, 50, "a single slow tick is never sampled away");
    assert.strictEqual(line.tickP50Ms, 0.1);
  });

  describe("fed by a live room", () => {
    let colyseus: ColyseusTestServer<typeof appConfig>;
    before(async () => (colyseus = await testServer()));
    beforeEach(async () => colyseus.cleanup());

    it("counts the room, its players and its ticks", async () => {
      metrics.flush(0, 0, MEMORY); // start a clean window
      const host = await colyseus.sdk.create("match", { name: "Ada" });
      await colyseus.sdk.joinById(host.roomId, { name: "Bob" });
      await new Promise((r) => setTimeout(r, 300)); // a few 50 ms ticks
      assert.deepStrictEqual(roomStats(), { rooms: 1, players: 2 });
      const line = metrics.flush(roomStats().rooms, roomStats().players, MEMORY)!;
      assert.ok(line.ticks >= 3, `ticks ${line.ticks}`);
      assert.strictEqual(line.roomsCreated, 1);
      assert.ok(line.tickMaxMs >= 0);
    });
  });
});
