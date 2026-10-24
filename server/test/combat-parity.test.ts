// The server's combat numbers against the game's.
//
// The weapon rack, the katana, the PvP table and the match rules are shared
// (src/shared/), and src/combat.ts derives its guns from them; this checks that
// derivation. The rest of combat.ts mirrors literals in the engine, which this
// reads straight out of the engine's source, so a balance change in the game
// that is not made on the server fails here.
//
// Excluded from this package's `tsc` (it imports frontend code).
import assert from "assert";
import { readFileSync } from "fs";

import { FOCUS, GRENADE, GUNS, HEALTH, HITBOX, KILLS_TO_WIN, MELEE, MIN_WALL_TOP, RANGE, RESPAWN_MS, SPIKE, AIR_SPREAD } from "../src/combat.js";
import { KATANA_MELEE, PVP, WEAPONS } from "../../src/game/arsenal.js";
import { exportArrivals, exportColliders, serializeArrivals } from "../../scripts/export-colliders.js";

const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const engine = source("src/game/engine.ts");
const online = source("src/pages/Online.tsx");
const egypt = source("src/game/egypt.ts");

function contains(text: string, snippet: string, what: string) {
  assert.ok(text.includes(snippet), `${what}: expected the game to still contain \`${snippet}\``);
}

describe("combat parity with the game", () => {
  it("uses the engine's weapon rack", () => {
    for (const w of WEAPONS) {
      if (w.katana) {
        assert.strictEqual(MELEE.name, w.name);
        assert.strictEqual(MELEE.interval, w.interval);
        continue;
      }
      const g = GUNS[w.name];
      assert.ok(g, `server knows ${w.name}`);
      for (const k of ["magSize", "interval", "pellets", "spread", "adsSpread", "reloadTime"] as const) {
        assert.strictEqual(g[k], w[k], `${w.name}.${k}`);
      }
    }
    assert.strictEqual(Object.keys(GUNS).length + 1, WEAPONS.length);
  });

  it("deals the player-versus-player damage, not the solo rack's", () => {
    assert.deepStrictEqual(Object.keys(PVP.weapons).sort(), WEAPONS.map((w) => w.name).sort(), "a PVP entry per weapon");
    for (const [name, pvp] of Object.entries(PVP.weapons)) {
      const s = name === MELEE.name ? MELEE : GUNS[name];
      assert.deepStrictEqual({ damage: s.damage, headMul: s.headMul }, pvp, name);
    }
    assert.strictEqual(HEALTH.max, PVP.health);
    assert.strictEqual(FOCUS.damage, PVP.focusDash);
    assert.strictEqual(GRENADE.damage, PVP.grenade);
    // the health bar measures the same health
    contains(engine, "player.maxHp = on ? PVP.health : 120;", "server-combat max hp");
  });

  it("uses the katana's melee config", () => {
    assert.strictEqual(MELEE.reach, KATANA_MELEE.reach);
    assert.strictEqual(MELEE.cosArc, KATANA_MELEE.cosArc);
    assert.strictEqual(MELEE.focusGain, KATANA_MELEE.focusGain);
    contains(engine, `const chest = a.pos.clone().add(new THREE.Vector3(0, ${MELEE.chestY}, 0));`, "slash chest");
    contains(engine, `const head = a.pos.clone().add(new THREE.Vector3(0, ${MELEE.headY}, 0));`, "slash head");
    contains(engine, `meleeHits(eye, fwd, head, KATANA_MELEE.reach, ${MELEE.headCos})`, "slash head cone");
  });

  it("uses the engine's hitboxes, range and spread", () => {
    contains(engine, `body.clone().add(new THREE.Vector3(0, ${HITBOX.headY}, 0))`, "head centre");
    contains(engine, `.distanceTo(headC) < ${HITBOX.headR}`, "head radius");
    contains(engine, `minX: body.x - ${HITBOX.half}, maxX: body.x + ${HITBOX.half}`, "body width");
    contains(engine, `minY: body.y, maxY: body.y + ${HITBOX.height}`, "body height");
    contains(engine, `const wallT = raycastWorld(eye, dir, ${RANGE});`, "range");
    contains(engine, `function raycastWorld(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, minTopY = ${MIN_WALL_TOP})`, "low walls");
    contains(engine, `* (player.onGround ? 1 : ${AIR_SPREAD})`, "air spread");
  });

  it("uses the engine's grenade", () => {
    contains(engine, `vel: fwdVec().multiplyScalar(${GRENADE.speed}).add(new THREE.Vector3(0, ${GRENADE.lift}, 0)),`, "throw");
    contains(engine, `fuse: ${GRENADE.fuse},`, "fuse");
    contains(engine, `g.vel.y -= ${GRENADE.gravity} * dt;`, "gravity");
    contains(engine, `if (g.pos.y < ${GRENADE.bounceY}) {`, "bounce height");
    contains(engine, `g.vel.y = Math.abs(g.vel.y) * ${GRENADE.bounceUp};`, "bounce");
    contains(engine, `g.vel.x *= ${GRENADE.bounceSide};`, "roll");
    contains(engine, `explode(g.pos.clone(), ${GRENADE.radius / 0.8}, 120, true);`, "blast");
    contains(engine, "blastRemotes(pos, radius * 0.8, dmg);", "blast radius for players");
    contains(engine, `dmg: dmg * Math.sqrt(Math.max(0, 1 - d / radius)) * ${GRENADE.othersMul},`, "blast on others");
    contains(engine, "damagePlayer(dmg * Math.sqrt(Math.max(0, 1 - pd / (radius * 0.8))));", "blast on the thrower");
    contains(engine, `player.nadeCd = ${GRENADE.cooldown};`, "cooldown");
  });

  it("uses the engine's focus dash", () => {
    contains(engine, `let bestD = ${FOCUS.range};`, "dash range");
    contains(engine, `to.normalize().dot(fwd) > ${FOCUS.cos}`, "dash cone");
    contains(engine, `slowmoT = ${FOCUS.slowmo};`, "slow motion");
    contains(engine, `focusChain >= ${FOCUS.maxChain}`, "chain");
  });

  it("uses the engine's health, the lobby's respawn and win, and the traps' spikes", () => {
    contains(engine, `player.regenDelay = ${HEALTH.regenDelay};`, "regen delay");
    contains(engine, `p.hp = Math.min(p.maxHp, p.hp + ${HEALTH.regenPerS} * dt);`, "regen rate");
    // the lobby reads both from src/shared/rules.ts (shared-parity.test.ts bans local copies)
    assert.strictEqual(KILLS_TO_WIN, 15);
    assert.strictEqual(RESPAWN_MS, 3200);
    contains(online, "matchWinner(players, session.winnerId, KILLS_TO_WIN)", "win");
    contains(online, "}, RESPAWN_MS);", "respawn wait");
    contains(egypt, `return ${SPIKE.damage};`, "spike damage");
    contains(egypt, `hurtUntil = now + ${SPIKE.everyMs};`, "spike rate");
  });

  it("has the current map colliders", () => {
    const fresh = exportColliders();
    const shipped = JSON.parse(readFileSync(new URL("../src/maps/colliders.json", import.meta.url), "utf8"));
    assert.deepStrictEqual(shipped, JSON.parse(JSON.stringify(fresh)), "run `npx tsx scripts/export-colliders.ts`");
  });

  it("has the current arrival points (where the game puts bodies without walking)", () => {
    const shipped = readFileSync(new URL("../src/maps/arrivals.json", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.strictEqual(shipped, serializeArrivals(exportArrivals()), "run `npx tsx scripts/export-colliders.ts`");
  });
});
