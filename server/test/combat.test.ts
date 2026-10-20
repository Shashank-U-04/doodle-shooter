import assert from "assert";

import {
  addFocus,
  blastDamage,
  canDash,
  capacityOf,
  FOCUS,
  GRENADE,
  grenadeLanding,
  GUNS,
  HEALTH,
  HITBOX,
  holdWeapon,
  meleeHits,
  newArms,
  raycastBodies,
  raycastWorld,
  rayAABB,
  refill,
  regen,
  scatter,
  zoneAt,
} from "../src/combat.js";
import { ENVELOPES } from "../src/movement.js";

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const norm = (v: { x: number; y: number; z: number }) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

describe("combat rules", () => {
  it("measures a ray against a box like the engine", () => {
    const box = { minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: 4, maxZ: 6 };
    assert.strictEqual(rayAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, box, 100), 4);
    assert.strictEqual(rayAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, box, 100), -1);
    assert.strictEqual(rayAABB({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, box, 3), -1, "beyond maxDist");
    assert.strictEqual(rayAABB({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: 1 }, box, 100), 0, "starting inside");
  });

  it("finds the nearest body, head first, and stops at walls", () => {
    const o = { x: 0, y: 1.6, z: 0 };
    const fwd = { x: 0, y: 0, z: -1 };
    const near1 = { id: "a", feet: { x: 0, y: 0, z: -5 } };
    const far1 = { id: "b", feet: { x: 0, y: 0, z: -9 } };
    // aimed at chest height: body hit on the nearer one
    const body = raycastBodies({ x: 0, y: 1.0, z: 0 }, fwd, 160, [far1, near1]);
    assert.strictEqual(body?.id, "a");
    assert.strictEqual(body?.head, false);
    assert.ok(near(body!.dist, 5 - HITBOX.half));
    // aimed at the head
    const head = raycastBodies({ x: 0, y: HITBOX.headY, z: 0 }, fwd, 160, [near1]);
    assert.strictEqual(head?.head, true);
    // a wall at 3 m hides both
    assert.strictEqual(raycastBodies(o, fwd, 3, [near1, far1]), null);
    // aimed past them
    assert.strictEqual(raycastBodies(o, norm({ x: 1, y: 0, z: -1 }), 160, [near1, far1]), null);
  });

  it("walls come from the real district geometry", () => {
    // straight down through the street: the floor is too low to count as a wall
    assert.strictEqual(raycastWorld("district", { x: 0, y: 1.6, z: 38 }, { x: 0, y: -1, z: 0 }, 160), 160);
    // somewhere in the district a ray must be stopped short of 160 m
    assert.ok(raycastWorld("district", { x: 0, y: 1.6, z: 38 }, { x: 1, y: 0, z: 0 }, 160) < 160);
  });

  it("scatters pellets within the spread and not at all with zero noise", () => {
    const base = norm({ x: 0.2, y: 0.1, z: -1 });
    const exact = scatter(base, 0.05, () => 0.5);
    assert.ok(near(exact.x, base.x) && near(exact.y, base.y) && near(exact.z, base.z));
    for (let i = 0; i < 200; i++) {
      const d = scatter(base, 0.062);
      assert.ok(near(Math.hypot(d.x, d.y, d.z), 1));
      assert.ok(d.x * base.x + d.y * base.y + d.z * base.z > Math.cos(0.2));
    }
  });

  it("applies the katana's reach and cone", () => {
    const eye = { x: 0, y: 1.6, z: 0 };
    const fwd = { x: 0, y: 0, z: -1 };
    assert.ok(meleeHits(eye, fwd, { x: 0, y: 1.05, z: -2.5 }, 2.9, 0.35));
    assert.ok(!meleeHits(eye, fwd, { x: 0, y: 1.05, z: -3.5 }, 2.9, 0.35), "out of reach");
    assert.ok(!meleeHits(eye, fwd, { x: 2, y: 1.05, z: 0.5 }, 2.9, 0.35), "behind the arc");
  });

  it("scales blast damage by distance, ×1.5 for everyone but the thrower", () => {
    const at = { x: 0, y: 0.12, z: 0 };
    assert.ok(near(blastDamage(at, at, false), GRENADE.damage * GRENADE.othersMul));
    assert.ok(near(blastDamage(at, at, true), GRENADE.damage));
    assert.strictEqual(blastDamage(at, { x: GRENADE.radius, y: 0.12, z: 0 }, false), 0);
    const half = blastDamage(at, { x: GRENADE.radius / 2, y: 0.12, z: 0 }, false);
    assert.ok(near(half, GRENADE.damage * Math.sqrt(0.5) * 1.5));
  });

  it("lands a grenade where the engine's integration puts it", () => {
    const at = grenadeLanding({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, ENVELOPES.district[0]);
    assert.ok(at.z < -10 && at.z > -25, `rolled to z=${at.z}`);
    assert.ok(at.y >= GRENADE.bounceY && at.y < 1.5, `y=${at.y}`);
    // clamped to the zone
    const wall = grenadeLanding({ x: 54, y: 1.6, z: 0 }, { x: 1, y: 0, z: 0 }, ENVELOPES.district[0]);
    assert.strictEqual(wall.x, 55);
  });

  it("regenerates 11 hp/s after 4.5 s without damage", () => {
    assert.strictEqual(regen(50, 4000, 1), 50);
    assert.strictEqual(regen(50, 5000, 1), 61);
    assert.strictEqual(regen(115, 5000, 1), HEALTH.max);
  });

  it("budgets shots by time: one ready plus 150 ms worth", () => {
    assert.ok(near(capacityOf("SNIPER"), 1 + 150 / 900));
    assert.ok(near(capacityOf("RIFLE"), 1 + 150 / (1000 / 11)));
    const a = newArms(0);
    a.ready.SNIPER -= 1;
    refill(a, 450);
    assert.ok(a.ready.SNIPER < 1, "half an interval is not enough");
    refill(a, 900);
    assert.ok(a.ready.SNIPER >= 1);
    refill(a, 60_000);
    assert.ok(near(a.ready.SNIPER, capacityOf("SNIPER")), "a pause banks no extra sniper shot");
  });

  it("finishes a reload on time and cancels it on a weapon switch", () => {
    const a = newArms(0);
    a.mags.REVOLVER = 0;
    a.reload = { weapon: "REVOLVER", until: 1000 };
    refill(a, 999);
    assert.strictEqual(a.mags.REVOLVER, 0);
    refill(a, 1000);
    assert.strictEqual(a.mags.REVOLVER, GUNS.REVOLVER.magSize);
    a.reload = { weapon: "REVOLVER", until: 5000 };
    a.weapon = "REVOLVER";
    holdWeapon(a, "RIFLE");
    assert.strictEqual(a.reload, null);
  });

  it("runs the focus meter like the engine", () => {
    const a = newArms(0);
    addFocus(a, 0.34, 0);
    addFocus(a, 0.34, 0);
    assert.ok(!canDash(a, 0));
    addFocus(a, 0.34, 0);
    assert.ok(canDash(a, 10), "full meter opens the window");
    assert.strictEqual(a.focus, 0);
    assert.ok(!canDash(a, FOCUS.slowmo * 1000 + 1000), "window closes");
    // two dashes lock it until the window would have run out
    a.chain = FOCUS.maxChain;
    assert.ok(!canDash(a, 10));
  });

  it("knows which zone a point is in", () => {
    assert.strictEqual(zoneAt("district", { x: 0, y: 0, z: 0 }).id, "district");
    assert.strictEqual(zoneAt("valley", { x: 0, y: 0.2, z: 0 }).id, "surface");
    assert.strictEqual(zoneAt("valley", { x: 0, y: -139, z: 0 }).id, "interior");
    assert.strictEqual(zoneAt("tomb", { x: 0, y: -299, z: 0 }).id, "tomb");
  });
});
