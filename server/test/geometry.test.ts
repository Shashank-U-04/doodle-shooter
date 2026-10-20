// The server's movement volumes against the real maps.
//
// Builds the frontend's map geometry headlessly (as scripts/check-valley.ts
// does) and checks that every place a player can legitimately stand fits
// inside the server's envelope, so the validator can never clamp an honest
// body. Also keeps the server's weapon list in step with the game's.
//
// Excluded from this package's `tsc`, like the adapter test: it imports the
// frontend, which the root `tsc -b` type-checks.
import assert from "assert";
import * as THREE from "three";

import { ENVELOPES, WEAPONS, type Box } from "../src/movement.js";
import { buildDistrict } from "../../src/game/district.js";
import { buildEgypt } from "../../src/game/egypt.js";
import { WEAPONS as GAME_WEAPONS } from "../../src/game/weapons.js";
import { XN, XN_AIR } from "../../src/game/enemies-data.js";

type Collider = { minY: number; maxY: number };
type Zone = {
  id: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  floorY: number;
  colliders: Collider[];
  spawns: THREE.Vector3[];
  start?: THREE.Vector3;
};

/** Below this the engine rescues a falling player back to the start pad. */
const RESCUE_DEPTH = 6;
/** A jump plus a double jump straight up from a standing start, metres. */
const JUMP_HEIGHT = (XN * XN + XN_AIR * XN_AIR) / (2 * 22);

const inside = (b: Box, x: number, y: number, z: number) =>
  x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;

function boxFor(envelope: readonly Box[], zone: Zone): Box {
  const box = envelope.find((b) => inside(b, 0, zone.floorY + 1, (zone.bounds.minZ + zone.bounds.maxZ) / 2));
  assert.ok(box, `no envelope box contains zone ${zone.id}`);
  return box;
}

function checkZone(envelope: readonly Box[], zone: Zone) {
  const box = boxFor(envelope, zone);
  const roof = Math.max(...zone.colliders.map((c) => c.maxY));
  assert.ok(box.minX <= zone.bounds.minX && box.maxX >= zone.bounds.maxX, `${zone.id}: x bounds`);
  assert.ok(box.minZ <= zone.bounds.minZ && box.maxZ >= zone.bounds.maxZ, `${zone.id}: z bounds`);
  assert.ok(box.minY <= zone.floorY - RESCUE_DEPTH, `${zone.id}: room to fall to the rescue line`);
  assert.ok(box.maxY >= roof + JUMP_HEIGHT, `${zone.id}: room to jump off the highest roof (${roof.toFixed(1)})`);
  // ...and not a sky-high allowance either
  assert.ok(box.maxY <= roof + 20, `${zone.id}: ceiling margin stays modest`);
  for (const p of [...zone.spawns, ...(zone.start ? [zone.start] : [])]) {
    assert.ok(inside(box, p.x, p.y, p.z), `${zone.id}: spawn ${p.toArray().join(",")} is playable`);
  }
}

describe("movement volumes against the real maps", () => {
  it("cover the district", () => {
    const d = buildDistrict(new THREE.Group());
    checkZone(ENVELOPES.district, {
      id: "district",
      bounds: d.bounds,
      floorY: 0,
      colliders: d.colliders,
      spawns: d.spawnPoints,
    });
  });

  it("cover all three Egyptian zones on every Egyptian map", () => {
    const egypt = buildEgypt(new THREE.Scene());
    for (const map of ["valley", "sanctuary", "tomb"] as const) {
      for (const z of Object.values(egypt.zones)) {
        checkZone(ENVELOPES[map], {
          id: `${map}/${z.id}`,
          bounds: z.bounds,
          floorY: z.floorY,
          colliders: z.colliders,
          spawns: z.spawnPoints,
          start: z.start,
        });
      }
    }
  });

  it("know every weapon a body can hold", () => {
    assert.deepStrictEqual([...WEAPONS].sort(), GAME_WEAPONS.map((w) => w.name).sort());
  });
});
