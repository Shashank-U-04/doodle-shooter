// The frontend and the server read one copy of the shared rules (src/shared/).
//
// This checks the frontend really uses it — the same objects, not copies — and
// that no hand-copied rule constant has crept back into the frontend's source.
//
// Excluded from this package's `tsc` (it imports frontend code).
import assert from "assert";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

import * as rules from "../src/shared/rules.js";
import * as weapons from "../src/shared/weapons.js";
import { MAPS, isMapId as frontendIsMapId } from "../../src/game/maps.js";
import { drawRoomCode as frontendDrawRoomCode } from "../../src/game/room.js";
import { KATANA_MELEE, PVP, WEAPONS } from "../../src/game/arsenal.js";

const frontendRoot = fileURLToPath(new URL("../../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "convex" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("shared rules", () => {
  it("every map id has one selector entry, and every entry is a map id", () => {
    assert.deepStrictEqual(
      MAPS.map((m) => m.id).sort(),
      [...rules.MAP_IDS].sort(),
    );
    assert.ok(rules.isMapId(rules.DEFAULT_MAP));
    assert.strictEqual(frontendIsMapId, rules.isMapId);
  });

  it("the lobby draws room codes with the server's function", () => {
    assert.strictEqual(frontendDrawRoomCode, rules.drawRoomCode);
  });

  it("the engine plays with the server's weapon tables", () => {
    assert.strictEqual(WEAPONS, weapons.WEAPONS);
    assert.strictEqual(PVP, weapons.PVP);
    assert.strictEqual(KATANA_MELEE, weapons.KATANA_MELEE);
    assert.deepStrictEqual(Object.keys(PVP.weapons).sort(), WEAPONS.map((w) => w.name).sort(), "a PVP entry per weapon");
  });

  it("no frontend file redeclares a shared rule", () => {
    const names = [
      ...Object.keys(rules).filter((k) => /^[A-Z][A-Z0-9_]+$/.test(k)),
      "WEAPONS",
      "PVP",
      "KATANA_MELEE",
    ];
    const declared = new RegExp(`\\b(?:const|let|var)\\s+(${names.join("|")})\\s*[:=]`);
    const offenders = sources(frontendRoot)
      .map((path) => ({ path, match: readFileSync(path, "utf8").match(declared) }))
      .filter((f) => f.match)
      .map((f) => `${f.path}: ${f.match![1]}`);
    assert.deepStrictEqual(offenders, [], "import these from server/src/shared instead");
  });
});
