// DOODLE DISTRICT — rebuilt to the original map layout:
// boundary walls, an elevated road along z=-30, the central tower with slabs and a
// spiral fire-escape, windowed city blocks with railings, warehouses + water tank,
// street-level plaza props (truck, containers, silo, fountain), and blue sky rings.

import * as THREE from "three";
import { INK, type InkId, makeInkMaterial, type Collider } from "./world";

export type District = {
  colliders: Collider[];
  spawnPoints: THREE.Vector3[];
  sniperSpots: THREE.Vector3[];
  pickupSpots: THREE.Vector3[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
};

export function buildDistrict(scene: THREE.Scene): District {
  const colliders: Collider[] = [];
  const spawnPoints: THREE.Vector3[] = [];
  const sniperSpots: THREE.Vector3[] = [];
  const pickupSpots: THREE.Vector3[] = [];
  const B = 55; // half-size (original: 55)
  const H = 18; // wall height

  const mat = (ink: InkId, fill: boolean) => {
    const m = makeInkMaterial(ink, fill);
    MATS.push(m);
    return m;
  };
  const MATS: THREE.Material[] = [];

  const bx = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    ink: InkId = INK.BLUE,
    fill = false,
    collide = true,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(ink, fill));
    mesh.position.set(x, y + h / 2, z);
    scene.add(mesh);
    if (collide) colliders.push({ minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2 });
    return mesh;
  };

  // ---- boundary: paper ground + walls + ceiling skirt (as in vr()) ----
  bx(2 * B + 6, 1, 2 * B + 6, 0, -1, 0, INK.BLUE); // ground slab (top at y=0)
  bx(2 * B + 6, H, 6, 0, 0, -B, INK.BLUE);
  bx(2 * B + 6, H, 6, 0, 0, B, INK.BLUE);
  bx(6, H, 2 * B + 6, -B, 0, 0, INK.BLUE);
  bx(6, H, 2 * B + 6, B, 0, 0, INK.BLUE);

  // ---- sky-dome rings (decor only) ----
  {
    const R = 96;
    for (let i = 0; i < 6; i++) {
      const g = new THREE.TorusGeometry(R, 0.5, 5, 80, Math.PI);
      g.rotateY((i * Math.PI) / 6);
      g.translate(0, -22, 0);
      const m = new THREE.Mesh(g, mat(INK.BLUE, false));
      scene.add(m);
    }
    for (const h of [30, 46, 60, 70]) {
      const r = Math.sqrt(R * R - (h + 22) * (h + 22));
      const g = new THREE.TorusGeometry(r, 0.4, 5, 96);
      g.rotateX(Math.PI / 2);
      g.translate(0, h, 0);
      const m = new THREE.Mesh(g, mat(INK.BLUE, false));
      scene.add(m);
    }
  }

  // ---- elevated road along z=-30 (deck at y=7, piers, dashed lines, end stairs) ----
  bx(2 * B, 0.6, 9, 0, 7, -30, INK.BLUE, false);
  for (let q = -48; q <= 48; q += 12) bx(1.4, 6.4, 1.4, q, 0, -30, INK.BLUE, false);
  for (let q = -50; q < 50; q += 4) bx(2, 0.02, 0.2, q + 1, 7.02, -30, INK.BLACK, false, false);
  // ramps up to the road
  const ramp = (x0: number, dir: 1 | -1) => {
    const steps = 14;
    for (let i = 0; i < steps; i++) {
      const z = -30 + dir * (5.5 + i * 0.9);
      const y = 0.4 + i * 0.5;
      bx(25, 0.5, 1.1, x0, y, z, INK.BLUE, false);
      if (i % 3 === 0) colliders.push({ minX: x0 - 12.5, maxX: x0 + 12.5, minY: y, maxY: y + 0.5, minZ: z - 0.55, maxZ: z + 0.55 });
    }
  };
  ramp(-46.5, 1);
  ramp(46.5, 1);
  spawnPoints.push(new THREE.Vector3(-48, 7.2, -30));
  spawnPoints.push(new THREE.Vector3(48, 7.2, -30));
  sniperSpots.push(new THREE.Vector3(0, 7.4, -30));

  // ---- central tower: slabs + corner pillars + railings + spiral stairs ----
  for (let n = 1; n <= 4; n++) bx(14, 0.4, 14, 0, n * 4, 0, INK.BLUE, false);
  for (const [x, z] of [
    [-6.6, -6.6], [6.6, -6.6], [-6.6, 6.6], [6.6, 6.6], [0, -6.6], [0, 6.6], [-6.6, 0], [6.6, 0],
  ]) bx(0.8, 16, 0.8, x, 0, z, INK.BLUE, false);
  const rail = (x1: number, z1: number, x2: number, z2: number, y: number) => {
    bx(Math.abs(x2 - x1) || 0.12, 0.9, Math.abs(z2 - z1) || 0.12, (x1 + x2) / 2, y, (z1 + z2) / 2, INK.BLUE, false);
  };
  rail(-7, -7, 7, -7, 4); rail(-7, 7, 7, 7, 4); rail(-7, -7, -7, 7, 4); rail(7, -7, 7, 7, 4);
  rail(-7, -7, 7, -7, 8); rail(-7, 7, 7, 7, 8); rail(-7, -7, -7, 7, 8); rail(7, -7, 7, 7, 8);
  rail(-7, -7, 7, -7, 12); rail(-7, 7, 7, 7, 12); rail(-7, -7, -7, 7, 12); rail(7, -7, 7, 7, 12);
  rail(-5, -7, 7, -7, 16); rail(-7, 7, 7, 7, 16); rail(-7, -7, -7, 7, 16);
  // tower crown: engine block + fan ring
  bx(1, 10, 1, 5.5, 16, 5.5, INK.BLUE, false);
  bx(1.6, 1.4, 1.6, 5.5, 25.2, 5.5, INK.BLUE, false, false);
  bx(16, 0.8, 0.8, 11.5, 25, 5.5, INK.BLUE, false, false);
  bx(5, 0.8, 0.8, 1, 25, 5.5, INK.BLUE, false, false);
  bx(2, 1.6, 1.6, -0.5, 23.6, 5.5, INK.BLUE, false, false);
  bx(0.08, 4.6, 0.08, 19, 20.5, 5.5, INK.BLACK, false, false);
  const fan = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.06, 4, 12), mat(INK.BLUE, false));
  fan.position.set(19, 19.8, 5.5);
  scene.add(fan);
  const fan2 = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.05, 4, 12), mat(INK.BLUE, false));
  fan2.rotation.y = Math.PI / 2;
  fan2.position.set(19.5, 24.6, 5.5);
  scene.add(fan2);
  // spiral fire-escape around the tower + a lower landing
  let sy = 0;
  for (let n = 0; n < 4; n++) {
    const dir: 1 | -1 = n % 2 === 0 ? 1 : -1;
    const sx = dir === 1 ? -5 : 1.3;
    const sz = n % 2 === 0 ? -8.3 : -10.3;
    // sloped stair (approximated with colliding steps)
    for (let i = 0; i < 14; i++) {
      const stepX = sx + dir * (i * 0.5);
      const stepY = sy + i * 0.286;
      bx(0.7, 0.28, 1.8, stepX, stepY, sz, INK.BLUE, false);
      if (i % 2 === 0) colliders.push({ minX: stepX - 0.35, maxX: stepX + 0.35, minY: stepY, maxY: stepY + 0.28, minZ: sz - 0.9, maxZ: sz + 0.9 });
    }
    sy += 4;
    const lx = dir === 1 ? 2.4 : -6.1;
    bx(2.2, 0.4, 4.4, lx, sy, -9.2, INK.BLUE, false);
    colliders.push({ minX: lx - 1.1, maxX: lx + 1.1, minY: sy, maxY: sy + 0.4, minZ: -11.4, maxZ: -7 });
  }
  spawnPoints.push(new THREE.Vector3(0, 8.2, 0));
  spawnPoints.push(new THREE.Vector3(0, 4.2, 3));
  sniperSpots.push(new THREE.Vector3(0, 16.2, -3));
  pickupSpots.push(new THREE.Vector3(0, 12.2, 0));
  pickupSpots.push(new THREE.Vector3(-4, 8.2, 4));
  pickupSpots.push(new THREE.Vector3(0, 16.2, 0));

  // ---- NW quarter: fire-escape block, billboard wall, rooftop railings ----
  for (let n = 1; n <= 3; n++) bx(24, 0.4, 16, -11.5, n * 4, -25, INK.BLUE, false);
  // window grid on the tall wall (x from 4..20 at z=-25..-43) — original `a(...)`/`o(...)` windowed facades
  for (let f = 0; f < 3; f++) {
    const y = f * 4;
    for (const [wx, wz] of [[10, -25], [14, -25], [8, -34], [12, -34], [16, -34], [6, -43], [10, -43], [14, -43]]) {
      bx(3.2, 2.6, 0.1, wx, y + 1.2, wz, INK.BLACK, true, false);
    }
  }
  bx(20, 12, 0.4, 12, 0, -25.2, INK.BLUE, false);
  bx(20, 12, 0.4, 12, 0, -42.8, INK.BLUE, false);
  bx(0.4, 12, 18, 4.2, 0, -34, INK.BLUE, false);
  bx(0.4, 12, 18, 19.8, 0, -34, INK.BLUE, false);
  // roof railings
  rail(-43, -37, -43, -25, 12); rail(-31, -37, -31, -25, 12); rail(-43, -37, -25, -37, 12); rail(-43, -25, -25, -25, 12);
  // rooftop stairs between levels + landing
  let wy = 0;
  for (let g = 0; g < 3; g++) {
    const dir: 1 | -1 = g % 2 === 0 ? -1 : 1;
    const sx = dir === -1 ? -28.5 : -34.8;
    const sz = g % 2 === 0 ? 21.2 : 23.2;
    for (let i = 0; i < 14; i++) {
      const stepY = wy + i * 0.286;
      const stepX = sx + (dir === -1 ? 1 : -1) * 0 + (dir === -1 ? -i * 0.45 : i * 0.45) * 0 + (dir === -1 ? -0.45 : 0.45) * 0;
      bx(1.8, 0.28, 0.7, sx + (dir === -1 ? i * 0.45 : -i * 0.45), stepY, sz, INK.BLUE, false);
      if (i % 2 === 0) colliders.push({ minX: sx + (dir === -1 ? i * 0.45 : -i * 0.45) - 0.9, maxX: sx + (dir === -1 ? i * 0.45 : -i * 0.45) + 0.9, minY: stepY, maxY: stepY + 0.28, minZ: sz - 0.35, maxZ: sz + 0.35 });
    }
    wy += 4;
    const lz = dir === -1 ? -35.9 : -27.4;
    bx(4.4, 0.4, 2.2, -31.5, wy, lz, INK.BLUE, false);
    colliders.push({ minX: -33.7, maxX: -29.3, minY: wy, maxY: wy + 0.4, minZ: lz - 1.1, maxZ: lz + 1.1 });
  }
  // orange crane arm over the street
  bx(2.4, 0.4, (12 + 25.2) / 2 + 6, -25 + (25.2 - 12) / 4, 11.6, 6, INK.ORANGE, false);
  for (let X = 0; X <= 25; X++) bx(0.06, 0.02, X % 5 === 0 ? 0.6 : 0.35, -25 + X, 12.02, 5, INK.BLACK, false, false);
  bx(0.4, 12, 0.9, -25, 7.2, 7.2, INK.ORANGE, false);
  spawnPoints.push(new THREE.Vector3(-34, 12.2, 12));
  spawnPoints.push(new THREE.Vector3(-40, 0.2, 18));
  sniperSpots.push(new THREE.Vector3(-27, 12.2, 6));
  pickupSpots.push(new THREE.Vector3(-34, 4.2, 12));
  pickupSpots.push(new THREE.Vector3(-30, 12.2, 16));
  pickupSpots.push(new THREE.Vector3(-40, 8.2, 8));

  // ---- NE quarter: windowed blocks with AC box + green crate + stairs ----
  for (const [x1, z1, x2, z2, y] of [
    [24, 4, 44, 9, 12], [24, 15, 44, 20, 12], [24, 9, 31, 15, 12], [37, 9, 44, 15, 12],
  ] as const) {
    bx(x2 - x1, 12, z2 - z1, (x1 + x2) / 2, y === 12 ? 0 : 12, (z1 + z2) / 2, INK.BLUE, false);
  }
  for (const [wx, wz] of [[32, 4], [28, 4], [39, 4], [27, 20], [40, 20], [34, 20], [24.2, 12], [43.8, 12]]) {
    bx(3, 2.4, 0.1, wx, 4, wz, INK.BLACK, true, false);
  }
  // rooftop AC + crate
  bx(2.4, 2.4, 2.4, 34, 12.2, 12, INK.BLUE, false);
  bx(2.4, 1.2, 2.4, 36.4, 12.2, 12, INK.BLUE, false);
  bx(1.6, 1.6, 1.6, 30, 12.2, 16, INK.GREEN, false);
  // long external stair up the block (with mid landing)
  for (let i = 0; i < 21; i++) {
    const stepY = 0.3 + i * 0.57;
    const stepZ = 8.6 + i * 0.62;
    bx(1.6, 0.3, 0.8, 26.2, stepY, stepZ, INK.BLUE, false);
    if (i % 2 === 0) colliders.push({ minX: 25.4, maxX: 27, minY: stepY, maxY: stepY + 0.3, minZ: stepZ - 0.4, maxZ: stepZ + 0.4 });
  }
  spawnPoints.push(new THREE.Vector3(34, 12.2, 18));
  spawnPoints.push(new THREE.Vector3(40, 0.2, 8));
  sniperSpots.push(new THREE.Vector3(26, 12.2, 18));
  pickupSpots.push(new THREE.Vector3(34, 0.2, 12));
  pickupSpots.push(new THREE.Vector3(34, 6.2, 19));
  pickupSpots.push(new THREE.Vector3(42, 12.2, 6));

  // ---- south side: overpass at z=-30 handled above; rooftop props + watertower ----
  // three warehouse boxes along z=-45 with roof lip boxes
  bx(14, 7, 10, -30, 0, -45, INK.BLUE, false);
  bx(14, 11, 10, -8, 0, -45, INK.BLUE, false);
  bx(14, 7, 10, 16, 0, -45, INK.BLUE, false);
  bx(2.6, 0.3, 5.5, -31, 6.7, -37.25, INK.BLUE, false, false);
  bx(2.6, 0.3, 5.5, 29, 6.7, -37.25, INK.BLUE, false, false);
  bx(2.6, 0.3, 5.5, 0, 6.7, -37.25, INK.BLUE, false, false);
  // short stairs to warehouse roofs
  for (let i = 0; i < 12; i++) {
    bx(2.2, 0.3 + i * 0.29, 0.8, -23 + i * 0.85, 0, -45, INK.BLUE, false);
    if (i % 2 === 0) colliders.push({ minX: -23 + i * 0.85 - 1.1, maxX: -23 + i * 0.85 + 1.1, minY: 0.3 + i * 0.29, maxY: 0.6 + i * 0.29, minZ: -45.4, maxZ: -44.6 });
  }
  for (let i = 0; i < 12; i++) {
    bx(2.2, 0.3 + i * 0.29, 0.8, 9 - i * 0.85, 0, -45, INK.BLUE, false);
    if (i % 2 === 0) colliders.push({ minX: 9 - i * 0.85 - 1.1, maxX: 9 - i * 0.85 + 1.1, minY: 0.3 + i * 0.29, maxY: 0.6 + i * 0.29, minZ: -45.4, maxZ: -44.6 });
  }
  // water tank: legs + cylinder tank on the middle warehouse
  for (const [lx, lz] of [[-33.2, -46.8], [-30.8, -46.8], [-33.2, -43.2], [-30.8, -43.2]]) {
    bx(0.35, 2.2, 0.35, lx, 11, lz, INK.BLACK, false, false);
  }
  {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 14), mat(INK.BLUE, false));
    tank.position.set(-32, 13.4, -45);
    scene.add(tank);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1.4, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2), mat(INK.BLUE, false));
    cap.position.set(-32, 14.7, -45);
    scene.add(cap);
    colliders.push({ minX: -33.4, maxX: -30.6, minY: 12.1, maxY: 14.8, minZ: -46.4, maxZ: -43.6 });
  }
  spawnPoints.push(new THREE.Vector3(-8, 11.2, -45));
  spawnPoints.push(new THREE.Vector3(-30, 7.2, -48));
  spawnPoints.push(new THREE.Vector3(16, 7.2, -45));
  sniperSpots.push(new THREE.Vector3(-8, 11.2, -48));
  sniperSpots.push(new THREE.Vector3(16, 7.2, -43));
  pickupSpots.push(new THREE.Vector3(-8, 11.2, -43));
  pickupSpots.push(new THREE.Vector3(-30, 7.2, -45));

  // ---- plaza (south, z>0): truck, crates, containers, silo, washline, fountain ----
  bx(2.5, 2.6, 6.2, -14, 0, 34, INK.GREEN, false);
  bx(2.5, 2.6, 6.2, -14, 2.6, 34, INK.ORANGE, false);
  bx(6.2, 2.6, 2.5, 14, 0, 36, INK.BLUE, false);
  bx(3, 2.6, 2.5, 17, 2.6, 36, INK.GREEN, false);
  bx(1.4, 1.4, 1.4, -6, 0, 28, INK.BLUE, false);
  bx(1.2, 1.2, 1.2, -4.5, 0, 28.5, INK.BLUE, false);
  bx(1, 1, 1, -5.3, 1.4, 28.2, INK.BLUE, false);
  bx(1.6, 1.6, 1.6, 8, 0, 26, INK.BLUE, false);
  bx(1.2, 1.2, 1.2, 9.6, 0, 26.4, INK.BLUE, false);
  bx(11, 3.2, 2.8, 24, 0.6, 40, INK.BLUE, false);
  bx(10, 0.6, 2.6, 24, 0, 40, INK.BLUE, false, false);
  for (const x of [20, 28]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 10), mat(INK.BLACK, false, THREE.DoubleSide, true));
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, 0.55, 41.5);
    scene.add(wheel);
    const wheel2 = wheel.clone();
    wheel2.position.z = 38.5;
    scene.add(wheel2);
  }
  // silo (lying cylinder) + nose cone + end cap
  {
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 16, 6), mat(INK.ORANGE, false));
    silo.rotation.z = Math.PI / 2;
    silo.position.set(-30, 0.8, 44);
    scene.add(silo);
    colliders.push({ minX: -38, maxX: -22, minY: 0, maxY: 1.6, minZ: 43.2, maxZ: 44.8 });
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.4, 6), mat(INK.BLACK, false));
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(-20.8, 0.8, 44);
    scene.add(nose);
    colliders.push({ minX: -22, maxX: -19.6, minY: 0, maxY: 1.6, minZ: 43.2, maxZ: 44.8 });
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 1.6, 8), mat(INK.PINK, false));
    cap.rotation.z = Math.PI / 2;
    cap.position.set(-38.8, 0.8, 44);
    scene.add(cap);
    colliders.push({ minX: -39.6, maxX: -38, minY: 0, maxY: 1.64, minZ: 43.2, maxZ: 44.8 });
  }
  // fountain: pink base ring + blue column
  bx(6, 2.2, 3.2, 38, 0, 40, INK.PINK, false);
  bx(6, 0.8, 3.2, 38, 2.2, 40, INK.BLUE, false);
  {
    const basin = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.35, 8, 16), mat(INK.BLUE, false));
    basin.rotation.x = Math.PI / 2;
    basin.position.set(-36.6, 1.8, 32);
    scene.add(basin);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.9, 3.4, 16), mat(INK.BLACK, false));
    col.position.set(-40, 1.7, 32);
    scene.add(col);
    colliders.push({ minX: -42.9, maxX: -37.1, minY: 0, maxY: 3.4, minZ: 29.1, maxZ: 34.9 });
  }
  // wash line: poles + hanging cloth (pink fill)
  bx(0.12, 2.2, 0.12, -10, 0, 46, INK.BLACK, false, false);
  bx(0.12, 2.2, 0.12, 10, 0, 46, INK.BLACK, false, false);
  bx(20, 0.05, 0.05, 0, 2.2, 46, INK.BLACK, false, false);
  bx(3.4, 1.8, 0.06, -3, 1.3, 46, INK.PINK, true, false);
  bx(2.6, 1.4, 0.06, 3, 1.4, 46, INK.ORANGE, true, false);

  // ---- scattered street spawns + street props ----
  for (const [x, z] of [[-52, -4], [52, -4], [-4, 50], [4, 50], [-52, 24], [52, 24], [-24, 52], [24, 52], [-48, -52], [48, -52]]) {
    bx(1.2, 3.2, 1.2, x, 0, z, INK.BLACK, false);
    bx(1.4, 0.3, 0.5, x + 0.5, 3.2, z, INK.BLACK, false, false);
  }
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const r = 20 + (i % 5) * 7;
    const x = Math.round(Math.cos(a) * r);
    const z = Math.round(Math.sin(a) * r);
    if (Math.abs(z + 30) < 6) continue; // keep road clear
    spawnPoints.push(new THREE.Vector3(x, 0.2, z));
  }
  spawnPoints.push(new THREE.Vector3(-30, 0.2, 12), new THREE.Vector3(30, 0.2, 12), new THREE.Vector3(0, 0.2, 20), new THREE.Vector3(-14, 0.2, 28), new THREE.Vector3(14, 0.2, 28));

  return {
    colliders,
    spawnPoints,
    sniperSpots,
    pickupSpots,
    bounds: { minX: -B + 2, maxX: B - 2, minZ: -B + 2, maxZ: B - 2 },
  };
}
