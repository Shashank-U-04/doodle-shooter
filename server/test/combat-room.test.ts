// Server-authoritative combat with real clients: intents go in over the
// WebSocket, hits/eliminations come back as events, health and scores as state.
//
// Determinism: each test stops the combat clock (cooldowns, reloads, fuses and
// respawns advance only when the test says) and removes spread noise, so a shot
// goes exactly where it is aimed. Waits are on events or state, never on time.
import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";
import type { Room as ClientRoom } from "@colyseus/sdk";

import type appConfig from "../src/app.config.js";
import { testServer } from "./harness.js";
import type { MatchRoom } from "../src/rooms/MatchRoom.js";
import type { EliminatedEvent, HitEvent } from "../src/rooms/Combat.js";
import { FOCUS, GRENADE, GUNS, HEALTH, KILLS_TO_WIN, MELEE, RESPAWN_MS, raycastWorld } from "../src/combat.js";
import collidersJson from "../src/maps/colliders.json" with { type: "json" };

type V = { x: number; y: number; z: number };
type Body = { hp: number; alive: boolean; kills: number; deaths: number; spawned: boolean; connected: boolean; x: number; y: number; z: number };

const EYE = 1.6;
const sub = (a: V, b: V) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const norm = (v: V) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const eyeOf = (feet: V) => ({ x: feet.x, y: feet.y + EYE, z: feet.z });
/** Aim from a body's eye at a point. */
const aim = (from: V, at: V) => ({ origin: eyeOf(from), dir: norm(sub(at, eyeOf(from))) });
const chestOf = (feet: V) => ({ x: feet.x, y: feet.y + 1.0, z: feet.z });
/** Low on the body: inside the katana's arc but outside its head cone. */
const hipsOf = (feet: V) => ({ x: feet.x, y: feet.y + 0.5, z: feet.z });
const headOf = (feet: V) => ({ x: feet.x, y: feet.y + 1.52, z: feet.z });

async function eventually(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sendUnchecked = (room: ClientRoom, type: string, message: unknown) =>
  (room.send as (type: string, message: unknown) => void)(type, message);

/** Clear street in the district: 8 m apart along z, nothing in between (checked). */
const A: V = { x: 0, y: 0.2, z: 38 };
const B: V = { x: 0, y: 0.2, z: 30 };

describe("server-authoritative combat", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => colyseus.cleanup());

  type Player = {
    room: ClientRoom;
    id: string;
    hits: HitEvent[];
    falls: EliminatedEvent[];
    shot: number;
    epoch: number;
    at: V;
  };

  /** A started match with players placed where asked; clock stopped at `t`. */
  async function match(spots: V[], map = "district") {
    const host = await colyseus.sdk.create("match", { name: "P0", map });
    const rooms: ClientRoom[] = [host];
    for (let i = 1; i < spots.length; i++) rooms.push(await colyseus.sdk.joinById(host.roomId, { name: `P${i}` }));
    const server = colyseus.getRoomById<MatchRoom>(host.roomId);
    await eventually(() => server.state.players.size === spots.length, "everyone joined");
    for (const r of rooms.slice(1)) r.send("ready", { ready: true });
    await eventually(() => [...server.state.players.values()].every((p) => p.ready), "everyone ready");
    assert.deepStrictEqual(await (host.request as (t: string) => Promise<unknown>)("start"), { ok: true });

    const clock = { t: 1_000_000 };
    server.combat.clock = () => clock.t;
    server.combat.random = () => 0.5; // no spread noise

    const players: Player[] = rooms.map((room, i) => {
      const p: Player = { room, id: room.sessionId, hits: [], falls: [], shot: 0, epoch: 1, at: spots[i] };
      room.onMessage("hit", (e: HitEvent) => p.hits.push(e));
      room.onMessage("eliminated", (e: EliminatedEvent) => p.falls.push(e));
      return p;
    });
    for (const p of players) place(p, p.at);
    await eventually(() => players.every((p) => body(p).spawned), "everyone placed");
    return { server, clock, players, body };

    function body(p: Player): Body {
      return server.state.players.get(p.id) as unknown as Body;
    }
  }

  /** Put a body somewhere (a teleport, so the speed limit does not apply). */
  function place(p: Player, at: V) {
    p.at = at;
    p.room.send("move", { ...at, yaw: 0, pitch: 0, moving: false, alive: true, weapon: "RIFLE", epoch: p.epoch++ });
  }

  const fire = (p: Player, weapon: string, target: V, extra: Partial<{ ads: boolean; air: boolean; lag: number; shot: number }> = {}) =>
    p.room.send("fire", { shot: extra.shot ?? ++p.shot, weapon, ...aim(p.at, target), ads: extra.ads ?? false, air: extra.air ?? false, lag: extra.lag ?? 0 });

  const refused = (server: MatchRoom, why: string) => server.combat.stats.refused[why as keyof typeof server.combat.stats.refused] ?? 0;
  /** Intents the server has finished with, accepted or refused. */
  const processed = (server: MatchRoom) =>
    server.combat.stats.accepted + Object.values(server.combat.stats.refused).reduce((n: number, v) => n + (v ?? 0), 0);
  /** Send one intent and wait until the server has dealt with it (the clock only moves between intents). */
  async function settle(server: MatchRoom, send: () => void) {
    const before = processed(server);
    send();
    await eventually(() => processed(server) > before, "intent processed");
  }

  it("the test street is clear", () => {
    const d = Math.hypot(B.z - A.z, 0, 0);
    assert.strictEqual(raycastWorld("district", eyeOf(A), norm(sub(chestOf(B), eyeOf(A))), 160) > d, true);
  });

  describe("hits and damage", () => {
    it("lands a body shot for the rifle's damage, and both players see the same health", async () => {
      const { players: [a, b], body } = await match([A, B]);
      fire(a, "RIFLE", chestOf(B));
      await eventually(() => a.hits.length === 1 && b.hits.length === 1, "hit announced to both");
      assert.deepStrictEqual(
        { ...a.hits[0], x: 0, y: 0, z: 0 },
        { attacker: a.id, victim: b.id, weapon: "RIFLE", damage: GUNS.RIFLE.damage, head: false, kill: false, x: 0, y: 0, z: 0 },
      );
      assert.strictEqual(body(b).hp, HEALTH.max - GUNS.RIFLE.damage);
      await eventually(() => (a.room.state as { players: Map<string, Body> }).players.get(b.id)?.hp === HEALTH.max - 24, "shooter's view");
      await eventually(() => (b.room.state as { players: Map<string, Body> }).players.get(b.id)?.hp === HEALTH.max - 24, "victim's view");
    });

    it("multiplies a headshot", async () => {
      const { players: [a, b], body } = await match([A, B]);
      fire(a, "RIFLE", headOf(B));
      await eventually(() => a.hits.length === 1, "hit");
      assert.strictEqual(a.hits[0].head, true);
      assert.ok(Math.abs(body(b).hp - (HEALTH.max - GUNS.RIFLE.damage * GUNS.RIFLE.headMul)) < 1e-3, `hp ${body(b).hp}`);
    });

    it("does nothing for a miss", async () => {
      const { server, players: [a, b], body } = await match([A, B]);
      fire(a, "RIFLE", { x: B.x + 5, y: 1, z: B.z });
      await eventually(() => server.combat.stats.accepted === 1, "shot processed");
      assert.strictEqual(body(b).hp, HEALTH.max);
      assert.strictEqual(a.hits.length, 0);
    });

    it("stops at walls", async () => {
      // a tall collider somewhere in the district, players on either side of it
      const wall = (collidersJson as { district: { colliders: number[][] } }).district.colliders.find(
        ([minX, , minZ, maxX, maxY, maxZ]) => maxY > 4 && maxX - minX > 3 && maxZ - minZ > 3 && maxZ - minZ < 20 && Math.abs(minX) < 40 && Math.abs(minZ) < 40,
      )!;
      const [minX, , minZ, maxX, , maxZ] = wall;
      const cx = (minX + maxX) / 2;
      const front = { x: cx, y: 0.2, z: minZ - 2 };
      const back = { x: cx, y: 0.2, z: maxZ + 2 };
      const { server, players: [a, b], body } = await match([front, back]);
      assert.ok(raycastWorld("district", eyeOf(front), norm(sub(chestOf(back), eyeOf(front))), 160) < maxZ - minZ + 4, "precondition: blocked");
      fire(a, "SNIPER", chestOf(back));
      await eventually(() => server.combat.stats.accepted === 1, "shot processed");
      assert.strictEqual(body(b).hp, HEALTH.max);
    });

    it("hits with as many shotgun pellets as land, in one event", async () => {
      const close = { x: 0, y: 0.2, z: 34 };
      const { players: [a, b], body } = await match([A, close]);
      fire(a, "SHOTGUN", chestOf(close));
      await eventually(() => a.hits.length === 1, "one event for the shot");
      // zero spread: all ten pellets take the same path, 190 in all, more than a body holds
      assert.strictEqual(GUNS.SHOTGUN.damage * GUNS.SHOTGUN.pellets, 190);
      assert.deepStrictEqual([a.hits[0].damage, a.hits[0].kill], [HEALTH.max, true], "the event reports health actually taken");
      assert.strictEqual(body(b).hp, 0);
    });

    it("compensates for lag, within the limit", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      // the guest walks 2 m sideways; the shooter fires at where they were 200 ms ago
      clock.t += 200;
      b.room.send("move", { ...B, x: 2, yaw: 0, pitch: 0, moving: true, alive: true, weapon: "RIFLE", epoch: b.epoch - 1 });
      await eventually(() => body(b).x === 2, "moved");
      clock.t += 50;
      fire(a, "RIFLE", chestOf(B), { lag: 0 });
      await eventually(() => server.combat.stats.accepted === 1, "first shot processed");
      assert.strictEqual(body(b).hp, HEALTH.max, "no lag claimed: the old spot is empty");
      clock.t += 100;
      fire(a, "RIFLE", chestOf(B), { lag: 320 });
      await eventually(() => a.hits.length === 1, "rewound hit");
      clock.t += 100;
      fire(a, "RIFLE", chestOf(B), { lag: 5000 }); // clamped to 350 ms: still inside the window
      await eventually(() => server.combat.stats.accepted === 3, "third shot processed");
    });
  });

  describe("firing rules", () => {
    it("refuses a shot faster than the weapon fires", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      fire(a, "SNIPER", chestOf(B));
      fire(a, "SNIPER", chestOf(B));
      await eventually(() => refused(server, "too-fast") === 1, "second refused");
      assert.strictEqual(server.combat.stats.accepted, 1);
      assert.strictEqual(body(b).deaths, 1, "the first shot (150) erased them; the second never fired");
      clock.t += GUNS.SNIPER.interval * 1000 - 200;
      fire(a, "SNIPER", chestOf(B));
      await eventually(() => refused(server, "too-fast") === 2, "still too early");
      clock.t += 200;
      fire(a, "SNIPER", chestOf(B));
      await eventually(() => server.combat.stats.accepted === 2, "after the interval");
    });

    it("lets jitter-bunched rifle fire through but caps the sustained rate", async () => {
      const { server, clock, players: [a, b] } = await match([A, { x: 0, y: 0.2, z: 10 }]);
      void b;
      for (let i = 0; i < 3; i++) fire(a, "RIFLE", { x: 9, y: 1, z: 10 }); // three at once after a pause
      await eventually(() => processed(server) === 3, "processed");
      assert.strictEqual(server.combat.stats.accepted, 2, "one ready + 150 ms banked = two");
      // then a client trying 20 shots a second, for a second: the rifle fires 11
      for (let i = 0; i < 20; i++) {
        clock.t += 1000 / 20;
        await settle(server, () => fire(a, "RIFLE", { x: 9, y: 1, z: 10 }));
      }
      const inSecond = server.combat.stats.accepted - 2;
      assert.ok(inSecond >= 10 && inSecond <= 12, `accepted ${inSecond} in a second (rifle: 11/s)`);
    });

    it("empties the magazine and refills it only after the reload time", async () => {
      const { server, clock, players: [a] } = await match([A, B]);
      const away = { x: 30, y: 1, z: 38 };
      for (let i = 0; i < GUNS.REVOLVER.magSize + 1; i++) {
        clock.t += 400;
        await settle(server, () => fire(a, "REVOLVER", away));
      }
      assert.strictEqual(server.combat.stats.accepted, GUNS.REVOLVER.magSize);
      assert.strictEqual(refused(server, "empty"), 1, "the seventh shot finds an empty cylinder");
      a.room.send("reload", { weapon: "REVOLVER" });
      clock.t += 1000;
      await settle(server, () => fire(a, "REVOLVER", away));
      assert.strictEqual(refused(server, "reloading"), 1, "mid-reload shot refused");
      clock.t += GUNS.REVOLVER.reloadTime * 1000;
      await settle(server, () => fire(a, "REVOLVER", away));
      assert.strictEqual(server.combat.stats.accepted, GUNS.REVOLVER.magSize + 1, "reloaded");
    });

    it("drops a repeated shot id", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      fire(a, "RIFLE", chestOf(B), { shot: 7 });
      clock.t += 500;
      fire(a, "RIFLE", chestOf(B), { shot: 7 });
      fire(a, "RIFLE", chestOf(B), { shot: 3 });
      await eventually(() => refused(server, "duplicate-shot") === 2, "replays refused");
      assert.strictEqual(body(b).hp, HEALTH.max - 24);
    });

    it("refuses an unknown weapon, a shot from somewhere else, and a non-unit aim", async () => {
      const { server, players: [a, b], body } = await match([A, B]);
      fire(a, "RAILGUN", chestOf(B));
      a.room.send("fire", { shot: 50, weapon: "RIFLE", origin: { x: 0, y: 1.6, z: 31 }, dir: { x: 0, y: 0, z: -1 }, ads: false, air: false, lag: 0 });
      a.room.send("fire", { shot: 51, weapon: "RIFLE", origin: eyeOf(A), dir: { x: 0, y: 0, z: -3 }, ads: false, air: false, lag: 0 });
      await eventually(
        () => refused(server, "unknown-weapon") === 1 && refused(server, "bad-origin") === 1 && refused(server, "bad-aim") === 1,
        "all three refused",
      );
      assert.strictEqual(body(b).hp, HEALTH.max);
    });

    it("has no message a client could use to claim damage", async () => {
      const { server, players: [a, b], body } = await match([A, B]);
      // the PeerJS transport's "I hit them" message, and a "death" claim
      sendUnchecked(a.room, "hit", { victim: b.id, dmg: 999, epoch: 1, origin: eyeOf(A) });
      sendUnchecked(a.room, "death", { killer: a.id });
      fire(a, "RIFLE", { x: 30, y: 1, z: 38 }); // a marker that the room processed what came before
      await eventually(() => server.combat.stats.accepted === 1, "marker processed");
      assert.strictEqual(body(b).hp, HEALTH.max);
      assert.strictEqual(body(a).kills, 0);
    });
  });

  describe("deaths, respawns and the score", () => {
    it("kills, announces it to everyone, scores it, and stops the dead from firing", async () => {
      const C = { x: 4, y: 0.2, z: 30 };
      const { server, clock, players: [a, b, c], body } = await match([A, B, C]);
      fire(a, "SNIPER", headOf(B)); // 450
      await eventually(() => c.falls.length === 1 && b.falls.length === 1 && a.falls.length === 1, "everyone told");
      assert.deepStrictEqual(c.falls[0], { victim: b.id, killer: a.id, weapon: "SNIPER" });
      assert.strictEqual(a.hits[0].kill, true);
      assert.strictEqual(a.hits[0].damage, HEALTH.max, "health taken, not the raw 450");
      assert.deepStrictEqual([body(b).alive, body(b).hp, body(b).deaths, body(a).kills], [false, 0, 1, 1]);

      clock.t += 1000;
      fire(b, "RIFLE", chestOf(A));
      await eventually(() => refused(server, "dead") === 1, "the dead cannot fire");
      clock.t += 1000;
      fire(a, "SNIPER", chestOf(B));
      await eventually(() => server.combat.stats.accepted === 2, "shot processed");
      assert.strictEqual(body(b).deaths, 1, "the dead cannot be hit again");
    });

    it("respawns when the wait is over and the client re-places the body", async () => {
      const { clock, players: [a, b], body } = await match([A, B]);
      fire(a, "SNIPER", headOf(B));
      await eventually(() => !body(b).alive, "down");
      clock.t += RESPAWN_MS - 1000;
      place(b, { x: 10, y: 0.2, z: 20 }); // too early: stays down
      await eventually(() => body(b).x === 10, "moved");
      assert.strictEqual(body(b).alive, false);
      clock.t += 1000;
      place(b, { x: 12, y: 0.2, z: 20 });
      await eventually(() => body(b).alive, "back");
      assert.strictEqual(body(b).hp, HEALTH.max);
    });

    it("resolves simultaneous shots deterministically: the first processed wins", async () => {
      const { server, players: [a, b], body } = await match([A, B]);
      fire(a, "SNIPER", headOf(B));
      fire(b, "SNIPER", headOf(A));
      await eventually(() => server.combat.stats.accepted + (server.combat.stats.refused.dead ?? 0) === 2, "both processed");
      const down = [body(a).alive, body(b).alive].filter((x) => !x).length;
      assert.strictEqual(down, 1, "exactly one died");
      const [winner, loser] = body(a).alive ? [a, b] : [b, a];
      assert.deepStrictEqual([body(winner).kills, body(loser).deaths, body(winner).hp], [1, 1, HEALTH.max]);
      await eventually(
        () => (a.room.state as { players: Map<string, Body> }).players.get(loser.id)?.alive === false &&
          (b.room.state as { players: Map<string, Body> }).players.get(loser.id)?.alive === false,
        "both clients agree",
      );
    });

    it("crowns the first to the winning score, freezes combat, and resets on the host's rematch", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      for (let k = 0; k < KILLS_TO_WIN; k++) {
        fire(a, "SNIPER", headOf(B));
        await eventually(() => body(a).kills === k + 1, `kill ${k + 1}`);
        // five rounds to a magazine: reload as a player would
        const reloads = server.combat.stats.reloads;
        a.room.send("reload", { weapon: "SNIPER" });
        await eventually(() => server.combat.stats.reloads === reloads + 1, "reloading");
        // past the wait and the fallback: the room's tick revives them even
        // without a re-placement (rapid respawns use up the teleport budget)
        clock.t += RESPAWN_MS + 2100;
        if (k < KILLS_TO_WIN - 1) await eventually(() => body(b).alive, "respawned");
      }
      assert.strictEqual(server.state.winnerId, a.id);
      fire(a, "RIFLE", chestOf(B));
      await eventually(() => refused(server, "match-over") === 1, "frozen");
      b.room.send("rematch");
      a.room.send("rematch");
      await eventually(() => server.state.round === 1, "host's rematch");
      assert.deepStrictEqual([server.state.winnerId, body(a).kills, body(b).deaths, body(b).alive, body(b).hp], ["", 0, 0, true, HEALTH.max]);
    });

    it("counts erasing yourself as a death but no kill", async () => {
      const { server, clock, players: [a], body } = await match([A, B]);
      a.room.send("throw", { shot: ++a.shot, origin: eyeOf(A), dir: { x: 0, y: -1, z: 0 } });
      await eventually(() => server.combat.stats.accepted === 1, "thrown");
      clock.t += GRENADE.fuse * 1000 + 10;
      await eventually(() => a.hits.length === 1, "blast");
      assert.strictEqual(a.hits[0].victim, a.id);
      assert.ok(a.hits[0].damage > 0 && a.hits[0].damage <= GRENADE.damage);
      assert.strictEqual(body(a).kills, 0);
    });
  });

  describe("grenades, the katana and the focus dash", () => {
    it("blasts everyone near the landing spot, after the fuse, credited to the thrower", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      // dropped straight down beside the target: it bounces in place and goes off at the thrower's feet
      const from = { x: B.x, y: 0.2, z: B.z + 1.5 };
      place(a, from);
      await eventually(() => body(a).z === from.z, "moved");
      a.room.send("throw", { shot: ++a.shot, origin: eyeOf(from), dir: { x: 0, y: -1, z: 0 } });
      await eventually(() => server.combat.stats.accepted === 1, "thrown");
      assert.strictEqual(body(b).hp, HEALTH.max, "nothing before the fuse");
      clock.t += GRENADE.fuse * 1000 + 10;
      await eventually(() => b.hits.some((h) => h.victim === b.id), "blast hit the target");
      assert.ok(body(b).hp < HEALTH.max);
      assert.strictEqual(b.hits.find((h) => h.victim === b.id)?.attacker, a.id);
      // a second throw inside the cooldown is refused
      a.room.send("throw", { shot: ++a.shot, origin: eyeOf(from), dir: { x: 0, y: 0, z: 1 } });
      a.room.send("throw", { shot: ++a.shot, origin: eyeOf(from), dir: { x: 0, y: 0, z: 1 } });
      await eventually(() => refused(server, "too-fast") === 1, "cooldown");
    });

    it("slashes within reach only", async () => {
      const near = { x: 0, y: 0.2, z: 36 };
      const { server, clock, players: [a, b], body } = await match([A, near]);
      a.room.send("slash", { shot: ++a.shot, ...aim(A, hipsOf(near)), lag: 0 });
      await eventually(() => a.hits.length === 1, "slash landed");
      assert.strictEqual(a.hits[0].head, false);
      assert.strictEqual(body(b).hp, HEALTH.max - MELEE.damage);
      clock.t += 400;
      place(b, B); // 8 m away
      await eventually(() => body(b).z === B.z, "moved away");
      a.room.send("slash", { shot: ++a.shot, ...aim(A, hipsOf(B)), lag: 0 });
      await eventually(() => server.combat.stats.accepted === 2, "processed");
      assert.strictEqual(a.hits.length, 1, "out of reach");
    });

    it("counts a chest-high slash at arm's length as a head cut, as the engine does", async () => {
      const near = { x: 0, y: 0.2, z: 36 };
      const { players: [a, b], body } = await match([A, near]);
      a.room.send("slash", { shot: ++a.shot, ...aim(A, chestOf(near)), lag: 0 });
      await eventually(() => a.hits.length === 1, "slash landed");
      assert.strictEqual(a.hits[0].head, true);
      assert.strictEqual(MELEE.damage * MELEE.headMul, HEALTH.max, "a head cut is 120: one slash erases");
      assert.strictEqual(body(b).alive, false);
    });

    it("opens the dash only after three landed slashes, and the dash hits for 95", async () => {
      const near = { x: 0, y: 0.2, z: 36 };
      const C = { x: 0.5, y: 0.2, z: 35.5 };
      const { server, clock, players: [a, b, c], body } = await match([A, near, C]);
      a.room.send("dash", { shot: ++a.shot, ...aim(A, chestOf(near)), lag: 0 });
      await eventually(() => refused(server, "no-focus") === 1, "no meter yet");
      // slash 1 catches both bodies: two charges (0.68), 75 each
      a.room.send("slash", { shot: ++a.shot, ...aim(A, hipsOf(near)), lag: 0 });
      await eventually(() => body(b).hp === HEALTH.max - MELEE.damage && body(c).hp === HEALTH.max - MELEE.damage, "both cut");
      // the third body steps back out of reach (still inside dash range)
      clock.t += 300;
      place(c, { x: 0.5, y: 0.2, z: 30 });
      await eventually(() => body(c).z === 30, "stepped back");
      a.room.send("dash", { shot: ++a.shot, ...aim(A, chestOf(c.at)), lag: 0 });
      await eventually(() => refused(server, "no-focus") === 2, "two charges are not enough");
      // slash 2 lands on the near body only: the third charge fills the meter
      a.room.send("slash", { shot: ++a.shot, ...aim(A, hipsOf(near)), lag: 0 });
      await eventually(() => !body(b).alive, "near body erased");
      clock.t += 300;
      a.room.send("dash", { shot: ++a.shot, ...aim(A, chestOf(c.at)), lag: 0 });
      await eventually(() => !body(c).alive, "the dash finished the far body");
      const last = a.hits.at(-1)!;
      assert.deepStrictEqual([last.victim, last.weapon, last.kill], [c.id, MELEE.name, true]);
      assert.strictEqual(last.damage, HEALTH.max - MELEE.damage, `health taken (the dash hits for ${FOCUS.damage})`);
    });
  });

  describe("connections and bad input", () => {
    it("cannot hit a player who has dropped, and can again once they are back", async () => {
      const { server, clock, players: [a, b], body } = await match([A, B]);
      const { sessionId, reconnectionToken } = b.room;
      b.room.reconnection.enabled = false;
      await b.room.leave(false);
      await eventually(() => !body(b).connected, "dropped");
      fire(a, "RIFLE", chestOf(B));
      await eventually(() => server.combat.stats.accepted === 1, "processed");
      assert.strictEqual(body(b).hp, HEALTH.max);
      const back = await colyseus.sdk.reconnect(reconnectionToken);
      assert.strictEqual(back.sessionId, sessionId);
      back.send("move", { ...B, yaw: 0, pitch: 0, moving: false, alive: true, weapon: "RIFLE", epoch: 1 });
      await eventually(() => body(b).connected, "back");
      clock.t += 200;
      fire(a, "RIFLE", chestOf(B));
      await eventually(() => body(b).hp === HEALTH.max - 24, "hit once back");
      // its shot counter starts over after a reload, and is accepted
      back.send("fire", { shot: 1, weapon: "RIFLE", ...aim(B, chestOf(A)), ads: false, air: false, lag: 0 });
      await eventually(() => body(a).hp === HEALTH.max - 24, "the reconnected player can fire");
    });

    it("disconnects a client that sends a malformed combat message", async () => {
      const { server, players: [a, b] } = await match([A, B]);
      void b;
      server.reconnectSeconds = 0.05;
      a.room.reconnection.enabled = false;
      let closed: number | undefined;
      a.room.onLeave((code) => (closed = code));
      sendUnchecked(a.room, "fire", { shot: 1, weapon: "RIFLE", origin: { x: Number.NaN, y: 1, z: 1 }, dir: { x: 0, y: 0, z: 1 }, ads: false, air: false, lag: 0 });
      await eventually(() => closed !== undefined, "kicked");
    });

    it("disconnects a client that floods fire messages", async () => {
      const { players: [a] } = await match([A, B]);
      a.room.reconnection.enabled = false;
      let closed: number | undefined;
      a.room.onLeave((code) => (closed = code));
      for (let i = 0; i < 200; i++) fire(a, "RIFLE", { x: 30, y: 1, z: 38 });
      await eventually(() => closed !== undefined, "kicked");
    });
  });
});
