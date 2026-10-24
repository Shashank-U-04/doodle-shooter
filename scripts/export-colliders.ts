// Export the maps' static colliders and arrival points for the match server.
//
// Run with `npx tsx scripts/export-colliders.ts` after changing map geometry.
// It builds the real maps headlessly (as check-valley.ts does) and writes:
//
// - server/src/maps/colliders.json: per zone, its floor height and every
//   axis-aligned collider except the doors players open in their own worlds
//   (EgyptMap.doorColliders). The server uses them for line of sight.
// - server/src/maps/arrivals.json: per zone, every point the game can put a
//   body without walking there: the zone's start, its spawn pads, the
//   district's safe spawns and the doorway arrivals. The server accepts a
//   client's teleport only to one of these (or a short hop right after a
//   focus dash it accepted).
//
// The server's test suite rebuilds the maps and fails if either file is stale.
// `--check` compares instead of writing, and exits 1 on any difference.

import { readFileSync, writeFileSync } from "fs";
import * as THREE from "three";
import { buildDistrict, DISTRICT_START, SAFE_SPAWNS } from "../src/game/district";
import { buildEgypt, DOORWAY_ARRIVALS } from "../src/game/egypt";
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

export type ZoneArrivals = [number, number, number][];

const point = (v: { x: number; y: number; z: number }): ZoneArrivals[number] => [
  Math.round(v.x * 100) / 100,
  Math.round(v.y * 100) / 100,
  Math.round(v.z * 100) / 100,
];

/** Per zone, every arrival point once, in a stable order. */
export function exportArrivals(): Record<string, ZoneArrivals> {
  const district = buildDistrict(new THREE.Group());
  const egypt = buildEgypt(new THREE.Scene());
  const unique = (points: ZoneArrivals) => {
    const seen = new Set<string>();
    return points.filter((p) => {
      const key = p.join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const out: Record<string, ZoneArrivals> = {
    district: unique([point(DISTRICT_START), ...district.spawnPoints.map(point), ...SAFE_SPAWNS.map(point)]),
  };
  for (const z of Object.values(egypt.zones)) {
    const doors = Object.values(DOORWAY_ARRIVALS).filter((d) => d.zone === z.id);
    out[z.id] = unique([point(z.start), ...z.spawnPoints.map(point), ...doors.map(point)]);
  }
  return out;
}

const TARGET = new URL("../server/src/maps/colliders.json", import.meta.url);
const ARRIVALS = new URL("../server/src/maps/arrivals.json", import.meta.url);

function serialize(data: Record<string, ZoneColliders>): string {
  // one collider per line keeps diffs of map edits readable
  const zones = Object.entries(data).map(([id, z]) => {
    const rows = z.colliders.map((c) => `      ${JSON.stringify(c)}`).join(",\n");
    return `  ${JSON.stringify(id)}: {\n    "floorY": ${z.floorY},\n    "colliders": [\n${rows}\n    ]\n  }`;
  });
  return `{\n${zones.join(",\n")}\n}\n`;
}

/** One point per line, like the colliders. */
export function serializeArrivals(data: Record<string, ZoneArrivals>): string {
  const zones = Object.entries(data).map(([id, points]) => {
    const rows = points.map((p) => `    ${JSON.stringify(p)}`).join(",\n");
    return `  ${JSON.stringify(id)}: [\n${rows}\n  ]`;
  });
  return `{\n${zones.join(",\n")}\n}\n`;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  const files = [
    { url: TARGET, name: "colliders.json", text: serialize(exportColliders()) },
    { url: ARRIVALS, name: "arrivals.json", text: serializeArrivals(exportArrivals()) },
  ];
  if (process.argv.includes("--check")) {
    const stale = files.filter((f) => readFileSync(f.url, "utf8").replace(/\r\n/g, "\n") !== f.text);
    for (const f of stale) console.error(`server/src/maps/${f.name} is stale: run \`npx tsx scripts/export-colliders.ts\``);
    if (stale.length > 0) process.exit(1);
    console.log("colliders.json and arrivals.json are current");
  } else {
    for (const f of files) writeFileSync(f.url, f.text);
    const colliders = JSON.parse(files[0].text) as Record<string, ZoneColliders>;
    for (const [id, z] of Object.entries(colliders)) console.log(`${id}: ${z.colliders.length} colliders, floor ${z.floorY}`);
    const arrivals = JSON.parse(files[1].text) as Record<string, ZoneArrivals>;
    for (const [id, points] of Object.entries(arrivals)) console.log(`${id}: ${points.length} arrival points`);
  }
}
