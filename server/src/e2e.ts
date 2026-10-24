// Test-only fixtures for the browser smoke tests (e2e/ in the repo root).
//
// A browser test cannot aim, so it cannot score fifteen kills in reasonable
// time. This route fast-forwards the score and then lands one real lethal hit
// through the room's own combat code: the kill accounting, the winner, the
// state patches, the `hit`/`eliminated` events, the arena overlay and the
// rematch all run exactly as in a match. Only the aiming is skipped (shots and
// hit detection are covered by test/combat*.test.ts).
//
// Mounted only when E2E_FIXTURES=1 and NODE_ENV is not production; see
// app.config.ts. Never set E2E_FIXTURES on a deployed server.

import express, { type Application } from "express";
import { matchMaker } from "colyseus";
import { KILLS_TO_WIN } from "./combat.js";
import type { MatchRoom } from "./rooms/MatchRoom.js";
import type { Player } from "./rooms/schema/MatchState.js";

export function e2eFixturesEnabled(env: Record<string, string | undefined>): boolean {
  return env.E2E_FIXTURES === "1" && env.NODE_ENV !== "production";
}

export function mountE2eFixtures(app: Application) {
  /**
   * POST /__e2e/rooms/:code/win { winner: "<player name>" }
   * 404: no such room or player · 409: nobody to kill yet (not placed or down)
   */
  app.post("/__e2e/rooms/:code/win", express.json(), (req, res) => {
    const room = matchMaker.getLocalRoomById(String(req.params.code).toUpperCase()) as MatchRoom | undefined;
    const name = String((req.body as { winner?: unknown } | undefined)?.winner ?? "");
    const players = room ? [...room.state.players.values()] : [];
    const winner = players.find((p) => p.name === name);
    if (!room || !winner) return void res.status(404).json({ error: "no such room or player" });
    if (room.state.phase !== "playing" || room.state.winnerId) return void res.status(409).json({ error: "not in play" });
    const victim = players.find((p) => p.id !== winner.id && p.spawned && p.alive);
    if (!victim) return void res.status(409).json({ error: "no placed, living opponent yet" });
    winner.kills = KILLS_TO_WIN - 1;
    // The room's own damage path (private on purpose: nothing a client sends reaches it).
    const hurt = room.combat["hurt"] as (v: Player, amount: number, attacker: string, weapon: string) => boolean;
    hurt.call(room.combat, victim, 9999, winner.id, "SNIPER");
    res.json({ winnerId: room.state.winnerId });
  });

  /**
   * GET /__e2e/rooms/:code/motion — how many teleports the room refused. The
   * real client's jumps (spawns, respawns, rematches, doorways, dashes) must
   * all be ones the server recognises, so a browser test expects zero.
   */
  app.get("/__e2e/rooms/:code/motion", (req, res) => {
    const room = matchMaker.getLocalRoomById(String(req.params.code).toUpperCase()) as MatchRoom | undefined;
    if (!room) return void res.status(404).json({ error: "no such room" });
    res.json(room.motionStats);
  });

  /**
   * POST /__e2e/rooms/:code/shutdown — what a host's SIGTERM does to each room
   * (matchMaker.gracefullyShutdown → room.onBeforeShutdown: the restart notice,
   * then the close with SERVER_SHUTDOWN), for one room, so a browser test can
   * watch the players' side of a server restart.
   */
  app.post("/__e2e/rooms/:code/shutdown", (req, res) => {
    const room = matchMaker.getLocalRoomById(String(req.params.code).toUpperCase());
    if (!room) return void res.status(404).json({ error: "no such room" });
    // the room's own shutdown hook, exactly what SIGTERM calls: the notice, then the close
    room.onBeforeShutdown();
    res.json({ ok: true });
  });
}
