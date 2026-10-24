import assert from "assert";

import { DEFAULT_ROOM_LIMITS, isCreateRequest, readRoomLimits, RoomCreationLimiter, TokenBucket } from "../src/limits.js";

describe("room-creation limits", () => {
  it("reads positive integers from the environment and reports the rest", () => {
    assert.deepStrictEqual(readRoomLimits({}), { limits: DEFAULT_ROOM_LIMITS, rejected: [] });
    const { limits, rejected } = readRoomLimits({
      MAX_ROOMS: "20",
      ROOM_CREATES_PER_MINUTE: "0",
      ROOM_CREATES_PER_IP_PER_MINUTE: "2.5",
    });
    assert.strictEqual(limits.maxRooms, 20);
    assert.strictEqual(limits.createsPerMinute, DEFAULT_ROOM_LIMITS.createsPerMinute);
    assert.strictEqual(limits.createsPerIpPerMinute, DEFAULT_ROOM_LIMITS.createsPerIpPerMinute);
    assert.deepStrictEqual(rejected.sort(), ["ROOM_CREATES_PER_IP_PER_MINUTE", "ROOM_CREATES_PER_MINUTE"]);
  });

  it("a bucket gives its burst, then refills continuously", () => {
    const b = new TokenBucket(3, 6, 0);
    assert.ok(b.take(0) && b.take(0) && b.take(0));
    assert.strictEqual(b.take(0), false);
    assert.strictEqual(b.take(9_999), false, "6/min is one token per 10 s");
    assert.strictEqual(b.take(10_000), true);
    assert.strictEqual(b.full(10_000), false);
    assert.strictEqual(b.full(40_000), true, "never above capacity");
    assert.strictEqual(b.peek(40_000), true);
  });

  it("one address gets its budget, a second address its own", () => {
    let now = 0;
    const limiter = new RoomCreationLimiter({ maxRooms: 100, createsPerMinute: 100, createsPerIpPerMinute: 2 }, () => now);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 0), null);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 1), null);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 2), "too-fast");
    assert.strictEqual(limiter.tryCreate("2.2.2.2", 2), null);
    now = 30_000; // one token back at 2/min
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 3), null);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 4), "too-fast");
  });

  it("the process-wide budget holds against any number of addresses", () => {
    const limiter = new RoomCreationLimiter({ maxRooms: 100, createsPerMinute: 3, createsPerIpPerMinute: 10 }, () => 0);
    // a client rotating forged X-Forwarded-For values is still one process budget
    assert.deepStrictEqual(
      ["a", "b", "c", "d", "e"].map((ip, i) => limiter.tryCreate(ip, i)),
      [null, null, null, "server-busy", "server-busy"],
    );
  });

  it("refuses at the live-room ceiling without spending anyone's budget", () => {
    const limiter = new RoomCreationLimiter({ maxRooms: 2, createsPerMinute: 1, createsPerIpPerMinute: 1 }, () => 0);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 2), "too-many-rooms");
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 1), null, "the refusal cost nothing");
  });

  it("a refusal by the global budget does not spend the address's budget", () => {
    let now = 0;
    const limiter = new RoomCreationLimiter({ maxRooms: 100, createsPerMinute: 1, createsPerIpPerMinute: 1 }, () => now);
    assert.strictEqual(limiter.tryCreate("1.1.1.1", 0), null);
    assert.strictEqual(limiter.tryCreate("2.2.2.2", 1), "server-busy");
    now = 60_000;
    assert.strictEqual(limiter.tryCreate("2.2.2.2", 1), null, "2.2.2.2 still had its own token");
  });

  it("callers without an address share one budget", () => {
    const limiter = new RoomCreationLimiter({ maxRooms: 100, createsPerMinute: 100, createsPerIpPerMinute: 1 }, () => 0);
    assert.strictEqual(limiter.tryCreate(undefined, 0), null);
    assert.strictEqual(limiter.tryCreate(undefined, 1), "too-fast");
  });

  it("configure() replaces the limits and starts the budgets over", () => {
    const limiter = new RoomCreationLimiter({ maxRooms: 1, createsPerMinute: 1, createsPerIpPerMinute: 1 }, () => 0);
    assert.strictEqual(limiter.tryCreate("x", 0), null);
    limiter.configure({ maxRooms: 5, createsPerMinute: 5, createsPerIpPerMinute: 5 });
    assert.strictEqual(limiter.tracked, 0);
    assert.strictEqual(limiter.tryCreate("x", 1), null);
    assert.deepStrictEqual(limiter.current, { maxRooms: 5, createsPerMinute: 5, createsPerIpPerMinute: 5 });
  });

  it("recognises create requests only", () => {
    assert.ok(isCreateRequest({ url: "http://host/matchmake/create/match" }));
    assert.ok(isCreateRequest({ url: "/matchmake/create/match?x=1" }));
    assert.strictEqual(isCreateRequest({ url: "http://host/matchmake/joinById/ABCD" }), false);
    assert.strictEqual(isCreateRequest({ url: "http://host/matchmake/joinOrCreate/match" }), false);
    assert.strictEqual(isCreateRequest(undefined), false);
    assert.strictEqual(isCreateRequest({}), false);
  });
});
