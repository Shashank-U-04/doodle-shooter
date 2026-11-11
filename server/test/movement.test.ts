import assert from "assert";

import {
  clampPitch,
  clampToEnvelope,
  ENVELOPES,
  MAX_SPEED,
  MOVE_BURST,
  newMotion,
  stepMotion,
  TELEPORT_BURST,
  wrapAngle,
  type Vec3,
} from "../src/movement.js";

const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe("movement rules", () => {
  const district = ENVELOPES.district;
  const egypt = ENVELOPES.valley;

  it("clamps a position into the map's volume", () => {
    assert.deepStrictEqual(clampToEnvelope({ x: 0, y: 1, z: 0 }, district), { x: 0, y: 1, z: 0 });
    assert.deepStrictEqual(clampToEnvelope({ x: 999, y: -50, z: -999 }, district), { x: 55, y: -8, z: -55 });
  });

  it("puts a point between Egypt's zones into the nearest one", () => {
    // just under the surface's floor margin: belongs to the surface, not 100 m down
    assert.strictEqual(clampToEnvelope({ x: 0, y: -20, z: 0 }, egypt).y, -8);
    // inside the sanctuary
    assert.deepStrictEqual(clampToEnvelope({ x: 1, y: -139, z: 2 }, egypt), { x: 1, y: -139, z: 2 });
    // inside the tomb
    assert.deepStrictEqual(clampToEnvelope({ x: 1, y: -299, z: 2 }, egypt), { x: 1, y: -299, z: 2 });
  });

  it("normalizes angles", () => {
    assert.ok(near(wrapAngle(0), 0));
    assert.ok(near(wrapAngle(Math.PI * 3), Math.PI));
    assert.ok(near(wrapAngle(-Math.PI / 2 - Math.PI * 4), -Math.PI / 2));
    assert.strictEqual(clampPitch(5), Math.PI / 2);
    assert.strictEqual(clampPitch(-5), -Math.PI / 2);
  });

  it("places a body that has no position yet wherever the client says, inside the volume", () => {
    const m = newMotion(0);
    const r = stepMotion(m, null, { x: 70, y: 1, z: 3 }, false, 0, district);
    assert.deepStrictEqual(r, { pos: { x: 55, y: 1, z: 3 }, teleported: true });
  });

  it("accepts ordinary movement within the allowance", () => {
    const m = newMotion(0);
    const from = { x: 0, y: 0, z: 0 };
    const r = stepMotion(m, from, { x: 3, y: 0, z: 4 }, false, 50, district);
    assert.deepStrictEqual(r, { pos: { x: 3, y: 0, z: 4 }, teleported: false });
  });

  it("limits a step that is too long to the banked allowance", () => {
    const m = newMotion(0);
    const from = { x: 0, y: 0, z: 0 };
    const r = stepMotion(m, from, { x: 50, y: 0, z: 0 }, false, 0, district);
    assert.strictEqual(r.teleported, false);
    assert.ok(near(r.pos.x, MOVE_BURST), `moved ${r.pos.x}`);
    // spent: nothing more until time passes
    const again = stepMotion(m, r.pos, { x: 50, y: 0, z: 0 }, false, 0, district);
    assert.ok(near(again.pos.x, MOVE_BURST));
  });

  it("refills the allowance at MAX_SPEED, capped at the burst", () => {
    const m = newMotion(0);
    m.allowance = 0;
    const from = { x: 0, y: 0, z: 0 };
    const r = stepMotion(m, from, { x: 50, y: 0, z: 0 }, false, 100, district); // 0.1 s later
    assert.ok(near(r.pos.x, MAX_SPEED * 0.1), `moved ${r.pos.x}`);
    m.allowance = 0;
    stepMotion(m, from, from, false, 100 + 60_000, district); // a minute idle
    assert.strictEqual(m.allowance, MOVE_BURST);
  });

  it("keeps sustained speed at MAX_SPEED however packets are timed", () => {
    const m = newMotion(0);
    let pos = { x: -50, y: 0, z: 0 };
    // claim 120 m/s for two seconds, at 20 Hz
    for (let t = 50; t <= 2000; t += 50) pos = stepMotion(m, pos, { x: pos.x + 6, y: 0, z: 0 }, false, t, district).pos;
    const travelled = pos.x + 50;
    assert.ok(travelled <= MOVE_BURST + MAX_SPEED * 2 + 1e-6, `travelled ${travelled}`);
  });

  it("lets a teleport skip the speed limit, a few at a time", () => {
    const m = newMotion(0);
    const from = { x: -40, y: 0, z: -40 };
    for (let i = 0; i < TELEPORT_BURST; i++) {
      const to = { x: 40 - i, y: 0, z: 40 };
      assert.deepStrictEqual(stepMotion(m, from, to, true, 0, district), { pos: to, teleported: true });
    }
    // out of teleports: the same request becomes a speed-limited step
    const r = stepMotion(m, from, { x: 40, y: 0, z: 40 }, true, 0, district);
    assert.strictEqual(r.teleported, false);
    assert.ok(dist(from, r.pos) <= MOVE_BURST + 1e-9);
    // one second later there is one again
    assert.strictEqual(stepMotion(m, from, { x: 40, y: 0, z: 40 }, true, 1000, district).teleported, true);
  });

  it("never walks a body from one Egyptian zone into another", () => {
    const m = newMotion(0);
    let pos = { x: 0, y: 0, z: 0 };
    for (let t = 0; t <= 10_000; t += 50) pos = stepMotion(m, pos, { x: 0, y: -139, z: 0 }, false, t, egypt).pos;
    assert.strictEqual(pos.y, -8, "stuck at the bottom of the surface volume");
  });

  it("teleports into a zone only inside its volume", () => {
    const m = newMotion(0);
    const r = stepMotion(m, { x: 0, y: 0, z: 0 }, { x: 40, y: -139, z: 0 }, true, 0, egypt);
    assert.deepStrictEqual(r, { pos: { x: 17, y: -139, z: 0 }, teleported: true });
  });
});
