import assert from "assert";

import {
  DEFAULT_MAP,
  drawRoomCode,
  freeInk,
  isMapId,
  MAP_IDS,
  normalizeMatchOptions,
  sanitizeName,
} from "../src/rules.js";

// The frontend uses these same functions and lists (src/shared/); the
// frontend side of that is checked in shared-parity.test.ts.
describe("rules", () => {
  it("knows the maps, and nothing else is one", () => {
    assert.deepStrictEqual([...MAP_IDS], ["district", "valley", "sanctuary", "tomb"]);
    assert.ok(MAP_IDS.every(isMapId));
    assert.ok(isMapId(DEFAULT_MAP));
    for (const bad of ["", "District", "moon", null, undefined, 3, {}]) assert.strictEqual(isMapId(bad), false, String(bad));
  });

  it("draws codes from the unambiguous alphabet", () => {
    assert.strictEqual(drawRoomCode(() => 0), "AAAA");
    assert.strictEqual(drawRoomCode(() => 0.9999), "9999");
    for (let i = 0; i < 200; i++) assert.match(drawRoomCode(), /^[A-HJ-NP-Z2-9]{4}$/);
  });

  it("sanitizes player names", () => {
    assert.strictEqual(sanitizeName("  Ada  ", "X"), "Ada");
    assert.strictEqual(sanitizeName("A\u0000d\u001fa\u007f", "X"), "Ada");
    assert.strictEqual(sanitizeName("x".repeat(40), "X"), "x".repeat(16));
    assert.strictEqual(sanitizeName("   ", "GUEST"), "GUEST");
    assert.strictEqual(sanitizeName(undefined, "GUEST"), "GUEST");
    assert.strictEqual(sanitizeName({ toString: () => "Obj" }, "GUEST"), "Obj");
  });

  it("normalizes room options", () => {
    assert.deepStrictEqual(normalizeMatchOptions(undefined), { map: "district", grapple: true, maxPlayers: 4 });
    assert.deepStrictEqual(normalizeMatchOptions({ map: "tomb", grapple: false, maxPlayers: 3 }), {
      map: "tomb",
      grapple: false,
      maxPlayers: 3,
    });
    assert.strictEqual(normalizeMatchOptions({ maxPlayers: 1 }).maxPlayers, 2);
    assert.strictEqual(normalizeMatchOptions({ maxPlayers: 2.5 }).maxPlayers, 4);
    assert.strictEqual(normalizeMatchOptions({ map: "__proto__" }).map, "district");
  });

  it("hands out the lowest free ink", () => {
    assert.strictEqual(freeInk([]), 0);
    assert.strictEqual(freeInk([0, 2]), 1);
    assert.strictEqual(freeInk([0, 1, 2, 3, 4, 5]), 0);
  });
});
