// Headless checks for the Pharaoh's Valley surface.
//
// Run with `bun scripts/check-valley.ts`. This does not draw anything: it builds
// the real map, then asserts the things a visual pass cannot be trusted to
// notice on its own — finite geometry, walkable pads, aligned colliders, and the
// three zone transitions still firing after the surface was re-dressed.

import * as THREE from "three";
import { buildEgypt, valleyGroundY } from "../src/game/egypt";
import { isStandable, resolveMove } from "../src/game/world";

const scene = new THREE.Scene();
const map = buildEgypt(scene);
const surface = map.zones.surface;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

let meshes = 0;
let triangles = 0;
let nonFinite = 0;
let degenerate = 0;
const perZone: Record<string, { meshes: number; tris: number }> = {};
for (const zone of Object.values(map.zones)) {
  const zs = (perZone[zone.id] = { meshes: 0, tris: 0 });
  zone.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    meshes++;
    zs.meshes++;
    const g = o.geometry;
    const pos = g.getAttribute("position");
    if (!pos) return;
    const tri = (g.index ? g.index.count : pos.count) / 3;
    triangles += tri;
    zs.tris += tri;
    for (let i = 0; i < pos.count; i++) {
      if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) nonFinite++;
    }
    g.computeBoundingBox();
    const b = g.boundingBox!;
    if (zone.id === "surface" && (b.min.y < -4.2 || b.max.y > 80)) degenerate++;
  });
}

console.log(`\nmeshes ${meshes}, triangles ${Math.round(triangles)}, colliders ${surface.colliders.length}`);
console.log(`per zone: ${Object.entries(perZone).map(([k, v]) => `${k} ${v.meshes}m/${Math.round(v.tris)}t`).join(", ")}`);
check("all vertex positions finite", nonFinite === 0, `${nonFinite} bad`);
check("surface geometry stays in a sane height band", degenerate === 0, `${degenerate} meshes`);
check(
  "colliders are finite and non-inverted",
  surface.colliders.every((c) => Object.values(c).every(Number.isFinite) && c.minX < c.maxX && c.minY < c.maxY && c.minZ < c.maxZ),
);
check("surface draw calls stay modest", perZone.surface.meshes < 80, `${perZone.surface.meshes} meshes`);
check("surface triangle count stays modest", perZone.surface.tris < 100000, `${Math.round(perZone.surface.tris)} triangles`);

// The sand field is visual only, but it has to be a continuous, gently varied
// surface: low under every hollow and water disc, and with no step between
// adjacent metre samples (which would draw a hard ridge across the desert).
let gMin = Infinity;
let gMax = -Infinity;
let gStep = 0;
for (let x = -58; x <= 58; x += 2) {
  for (let z = -58; z <= 58; z += 2) {
    const h = valleyGroundY(x, z);
    gMin = Math.min(gMin, h);
    gMax = Math.max(gMax, h);
    gStep = Math.max(gStep, Math.abs(valleyGroundY(x + 1, z) - h), Math.abs(valleyGroundY(x, z + 1) - h));
  }
}
check("sand field is continuous and gently undulating", gStep < 0.16, `range ${gMin.toFixed(3)}..${gMax.toFixed(3)}, max 1m step ${gStep.toFixed(3)}`);
check("sand field stays below the pyramid floor slabs", valleyGroundY(0, 0) < 0.02 && valleyGroundY(-36, 26) < 0.02 && valleyGroundY(36, -24) < 0.02);
check("oasis water stays exposed", valleyGroundY(-28, 46) < 0.02, valleyGroundY(-28, 46).toFixed(3));

let doubleSided = 0;
surface.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const m = o.material;
  if (m instanceof THREE.ShaderMaterial && m.side === THREE.DoubleSide) doubleSided++;
});
check("palm trunks and blades are drawn as rounded double-sided surfaces", doubleSided >= 2, `${doubleSided} meshes`);

const stand = (x: number, y: number, z: number) => isStandable(x, y, z, 0.42, 1.7, surface.colliders, 1.2);
const start = surface.start;
check("spawn is clear and supported", stand(start.x, start.y, start.z), start.toArray().map((n) => n.toFixed(1)).join(", "));

for (const p of surface.spawnPoints) {
  check(`wave pad (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) walkable`, stand(p.x, p.y, p.z));
}

/* ------------------------- the sphinx ------------------------- */
// The lion used to be one 5.6 m collider sitting on sand: every visible plinth
// step was decoration, and the only route onto it was blocked by the same box
// that made its body solid. It was also authored facing +z, which pointed its
// face at the southern cliffs. Both are checked from the built map.
type Box = (typeof surface.colliders)[number];
const LION = { x: 34, z: 36 };
const insidePlinth = (c: Box) =>
  c.minX >= 26.2 && c.maxX <= 41.8 && c.minZ >= 29.5 && c.maxZ <= 42.4 && c.minY <= 0.02 && c.maxY > 1.1;
const lionBoxes = surface.colliders.filter(
  (c) => c.maxX > 26.2 && c.minX < 41.8 && c.maxZ > 29.5 && c.minZ < 42.4 && c.minY < 6.5,
);
check("no collider runs from the sand straight to the lion's shoulders", !lionBoxes.some(insidePlinth), `${lionBoxes.length} boxes in the footprint`);
const tallest = lionBoxes.reduce((a, b) => (b.maxY > a.maxY ? b : a), lionBoxes[0] ?? { minZ: 0, maxZ: 0, maxY: 0 });
const headZ = (tallest.minZ + tallest.maxZ) / 2;
check(
  "lion faces away from the southern cliffs (head on the -z side)",
  tallest.maxY > 6 && headZ < LION.z,
  `tallest ${tallest.maxY.toFixed(1)} m at z ${headZ.toFixed(1)}`,
);
// the carved rear stair must be behind the body, i.e. on the +z side
const stair = lionBoxes.filter((c) => c.minY > 1.0 && c.minY < 1.1 && c.maxY > 1.5 && c.maxY < 3.0 && c.minZ > 39);
check("rear stair sits behind the lion", stair.length === 3, `${stair.length} treads`);
check(
  "rear stair risers stay within the step height",
  stair.map((c) => c.maxY).sort((a, b) => a - b).every((y, i, all) => y - (i === 0 ? 1.04 : all[i - 1]) <= 0.545),
  stair.map((c) => c.maxY.toFixed(2)).join(" → "),
);

// Walk it for real: sand → plinth → rear stair → the lion's back.
const walk = (from: THREE.Vector3, dir: THREE.Vector3, frames = 700) => {
  const p = from.clone();
  const vel = new THREE.Vector3();
  const dt = 1 / 60;
  for (let i = 0; i < frames; i++) {
    vel.x = dir.x * 3.2;
    vel.z = dir.z * 3.2;
    vel.y -= 18 * dt;
    const r = resolveMove(p, vel, 0.42, 1.7, surface.colliders, dt);
    if (r.onGround) vel.y = 0;
  }
  return p;
};
const climbed = walk(new THREE.Vector3(34.4, 0.2, 46), new THREE.Vector3(0, 0, -1));
check(
  "player can climb from the sand onto the lion's back",
  climbed.y >= 3.65 && climbed.z < 39.3,
  `ended at (${climbed.x.toFixed(2)}, ${climbed.y.toFixed(2)}, ${climbed.z.toFixed(2)})`,
);
const blocked = walk(new THREE.Vector3(46, 0.2, 36), new THREE.Vector3(-1, 0, 0));
check(
  "lion's body stays solid from the side",
  blocked.x > 38.7 && blocked.y < 3.2,
  `stopped at x ${blocked.x.toFixed(2)}, y ${blocked.y.toFixed(2)}`,
);

/* --------------------- pyramid palette and detail --------------------- */
// The complaint was that the pyramid was pale and empty next to the sand. Read
// the real merged geometry: every triangle of the upper pyramid shell, binned by
// the ink its material draws. This is the actual rendered palette, not the
// constants in a comment above it.
const INK_NAMES = ["BLUE", "RED", "BLACK", "ORANGE", "GREEN", "PINK", "SAND", "OCHRE", "STONE", "TURQ", "GOLD", "BONE"];
const shell: Record<string, number> = {};
let shellTris = 0;
surface.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const ink = (o.material as THREE.ShaderMaterial).uniforms?.uInk?.value;
  if (typeof ink !== "number") return;
  const g = o.geometry;
  const pos = g.getAttribute("position");
  const idx = g.index;
  const count = (idx ? idx.count : pos.count) / 3;
  for (let t = 0; t < count; t++) {
    const a = idx ? idx.getX(t * 3) : t * 3;
    const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const ring = Math.max(Math.abs(x), Math.abs(z));
    // the upper shell: above the entrance dressing, below the cap, on the
    // monument rather than the interior colonnade or the palms outside it
    if (ring < 10 || ring > 19.6 || y < 6 || y > 27) continue;
    const name = INK_NAMES[ink] ?? String(ink);
    shell[name] = (shell[name] ?? 0) + 1;
    shellTris++;
  }
});
const share = (name: string) => (shell[name] ?? 0) / Math.max(1, shellTris);
check("pyramid shell carries dressed stone detail", shellTris > 1200, `${shellTris} triangles`);
check("pyramid reads ochre, not sand", (shell.OCHRE ?? 0) > (shell.SAND ?? 0), `ochre ${(share("OCHRE") * 100).toFixed(0)}% vs sand ${(share("SAND") * 100).toFixed(0)}%`);
check(
  "pyramid palette stays warm sandstone",
  share("OCHRE") + share("SAND") + share("GOLD") > 0.75,
  `${((share("OCHRE") + share("SAND") + share("GOLD")) * 100).toFixed(0)}% warm`,
);
check("block-to-block colour variation is visible", Object.keys(shell).length >= 4, Object.keys(shell).join(", "));
check("pale bone is not the pyramid's face", share("BONE") < 0.02, `${(share("BONE") * 100).toFixed(1)}% bone`);

// The approved coconut palms must not drift while the rest of the valley is
// reworked. Their trunk and fronds are the only double-sided ink surfaces, so
// their triangle count is a cheap fingerprint of that geometry.
let palmTris = 0;
surface.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const m = o.material;
  if (!(m instanceof THREE.ShaderMaterial) || m.side !== THREE.DoubleSide) return;
  const g = o.geometry;
  palmTris += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
});
check("coconut palms keep their approved geometry", Math.round(palmTris) === 10110, `${Math.round(palmTris)} double-sided triangles`);

// the doorway is the one collider that must disappear: simulate the open
const door = map.nearest(new THREE.Vector3(0, 1.2, 20.4));
check("great door prompt reachable", door?.id === "main-door", door?.label ?? "none");
map.activate("main-door");
const player = new THREE.Vector3(0, 0.2, 30);
for (let i = 0; i < 80; i++) map.update(i * 0.05, 0.05, player);
check("door collider clears after opening", stand(0, 0.2, 16.7));
const approach: [number, number][] = [[20.5, 0.2], [19.4, 0.2], [18.5, 0.36], [17.3, 0.2], [16.5, 0.2], [15.5, 0.2], [14.5, 0.2]];
check(
  "threshold corridor is walkable",
  approach.every(([z, y]) => stand(0, y, z)),
  approach.filter(([z, y]) => !stand(0, y, z)).map(([z]) => z).join(", "),
);
const travel = map.travelAt(new THREE.Vector3(0, 0.2, 12.5));
check("surface → sanctuary transition intact", travel?.zone === "interior", JSON.stringify(travel));

// walk the approach for real: gravity, step-up and the plinth included
{
  const p = new THREE.Vector3(0, 0.2, 42);
  const vel = new THREE.Vector3();
  const dt = 1 / 60;
  let frames = 0;
  for (; frames < 600 && p.z > 13; frames++) {
    vel.z = -5.5;
    vel.x = 0;
    vel.y -= 18 * dt;
    const r = resolveMove(p, vel, 0.42, 1.7, surface.colliders, dt);
    if (r.onGround) vel.y = 0;
  }
  check("walk from spawn through the great door", p.z <= 13.1, `stopped at z ${p.z.toFixed(2)} (y ${p.y.toFixed(2)}) after ${frames} frames`);
}
map.setZone("interior");

// inner door + hatch chains
const inner = map.nearest(new THREE.Vector3(0, -138.8, 14.2));
check("sanctuary exit prompt reachable", inner?.id === "inner-exit", inner?.label ?? "none");
map.activate("inner-exit");
const out = map.travelAt(new THREE.Vector3(0, -139.8, 15.4));
check("sanctuary → surface transition intact", out?.zone === "surface", JSON.stringify(out));
map.setZone("interior");
const hatch = map.nearest(new THREE.Vector3(0, -139.2, 0));
check("hatch prompt reachable", hatch?.id === "hatch", hatch?.label ?? "none");
map.activate("hatch");
const down = map.activate("hatch");
check("hatch → tomb transition intact", down?.travel?.zone === "tomb", JSON.stringify(down?.travel));
const back = map.nearest(new THREE.Vector3(0, -298.4, 40.5));
check("tomb return prompt reachable", back?.id === "tomb-exit", back?.label ?? "none");
check("tomb → sanctuary transition intact", map.activate("tomb-exit")?.travel?.zone === "interior");

// the surviving small doors, chests and the temple lever still advertise
// themselves from the real approach points
const prompts: [string, THREE.Vector3][] = [
  ["west-pyramid-door", new THREE.Vector3(-36, 1.2, 36.3)],
  ["east-pyramid-door", new THREE.Vector3(36, 1.2, -13.7)],
  ["chest-temple", new THREE.Vector3(-25.6, 1.4, -31)],
  ["chest-temple-2", new THREE.Vector3(-42.4, 1.4, -31)],
  ["temple-lever", new THREE.Vector3(-24.6, 1.4, -39.5)],
  ["chest-rim", new THREE.Vector3(-50, 1.4, 30)],
];
for (const [id, p] of prompts) {
  const near = map.nearest(p);
  check(`prompt ${id} reachable`, near?.id === id, near?.id ?? "none");
}

// the temple's hidden alcove still opens and gives up its collider
map.activate("temple-lever");
for (let i = 0; i < 100; i++) map.update(i * 0.05, 0.05, player);
check("temple secret wall clears", stand(-22.5, 0.9, -39.5));

// the two smaller tombs still open onto a walkable chamber
for (const [id, x, z] of [["west-pyramid-door", -36, 34.1], ["east-pyramid-door", 36, -15.9]] as const) {
  map.activate(id);
  for (let i = 0; i < 100; i++) map.update(i * 0.05, 0.05, player);
  check(`${id} clears`, stand(x, 0.2, z));
}

// things that must still exist and answer their prompt
for (const id of ["chest-temple", "chest-temple-2", "chest-temple-secret", "chest-rim"]) {
  check(`interaction ${id} present`, map.activate(id) !== null);
}

// the two underground zones must not have gained surface decorations
const interiorTris = (() => {
  let n = 0;
  map.zones.interior.group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = o.geometry;
      n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
  });
  return Math.round(n);
})();
const tombTris = (() => {
  let n = 0;
  map.zones.tomb.group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const g = o.geometry;
      n += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
  });
  return Math.round(n);
})();
console.log(`\ninterior triangles ${interiorTris}, tomb triangles ${tombTris}`);
console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
