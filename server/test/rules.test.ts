import assert from "assert";
import { readFileSync } from "fs";

import {
  CODE_ALPHABET,
  drawRoomCode,
  freeInk,
  MAP_IDS,
  normalizeMatchOptions,
  sanitizeName,
} from "../src/rules.js";

describe("rules", () => {
  it("keeps the map list in step with the frontend", () => {
    // The server cannot import the browser bundle, so read its source instead.
    const source = readFileSync(new URL("../../src/game/maps.ts", import.meta.url), "utf8");
    const declared = source.match(/export type MapId = ([^;]+);/)?.[1] ?? "";
    const frontend = [...declared.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual([...MAP_IDS], frontend);
  });

  it("uses the same code alphabet as the frontend", () => {
    const source = readFileSync(new URL("../../src/game/room.ts", import.meta.url), "utf8");
    assert.ok(source.includes(`const CODE_ALPHABET = "${CODE_ALPHABET}"`));
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
