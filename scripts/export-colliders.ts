// Export the maps' static colliders for the match server.
//
// Run with `npx tsx scripts/export-colliders.ts` after changing map geometry.
// It builds the real maps headlessly (as check-valley.ts does) and writes
// server/src/maps/colliders.json: per zone, its floor height and every
// axis-aligned collider except the doors players open in their own worlds
// (EgyptMap.doorColliders). The server uses them for line of sight; its test
// suite rebuilds the maps and fails if this file is stale.
//
// `--check` compares instead of writing, and exits 1 on any difference.

import { readFileSync, writeFileSync } from "fs";
import * as THREE from "three";
import { buildDistrict } from "../src/game/district";
import { buildEgypt } from "../src/game/egypt";
import type { Collider } from "../src/game/world";

export type ZoneColliders = { floorY: number; colliders: [number, number, number, number, number, number][] };

const box = (c: Collider): ZoneColliders["colliders"][number] => [c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ];

export function exportColliders(): Record<string, ZoneColliders> {
  const district = buildDistrict(new THREE.Group());
  const egypt = buildEgypt(new THREE.Scene());
  const doors = new Set(egypt.doorColliders());
  const out: Record<string, ZoneColliders> = {
    district: { floorY: 0, colliders: district.colliders.map(box) },
  };
  for (const z of Object.values(egypt.zones)) {
    out[z.id] = { floorY: z.floorY, colliders: z.colliders.filter((c) => !doors.has(c)).map(box) };
  }
  return out;
}

const TARGET = new URL("../server/src/maps/colliders.json", import.meta.url);

function serialize(data: Record<string, ZoneColliders>): string {
  // one collider per line keeps diffs of map edits readable
  const zones = Object.entries(data).map(([id, z]) => {
    const rows = z.colliders.map((c) => `      ${JSON.stringify(c)}`).join(",\n");
    return `  ${JSON.stringify(id)}: {\n    "floorY": ${z.floorY},\n    "colliders": [\n${rows}\n    ]\n  }`;
  });
  return `{\n${zones.join(",\n")}\n}\n`;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const text = serialize(exportColliders());
  if (process.argv.includes("--check")) {
    const current = readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n");
    if (current !== text) {
      console.error("server/src/maps/colliders.json is stale: run `npx tsx scripts/export-colliders.ts`");
      process.exit(1);
    }
    console.log("colliders.json is current");
  } else {
    writeFileSync(TARGET, text);
    const data = JSON.parse(text) as Record<string, ZoneColliders>;
    for (const [id, z] of Object.entries(data)) console.log(`${id}: ${z.colliders.length} colliders, floor ${z.floorY}`);
  }
}
