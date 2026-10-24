// Server-authoritative combat for one match.
//
// Clients send intent only (fire, slash, dash, throw, reload, a spike trap
// they stood on); this class decides whether they may, what it hits, and what
// happens to everyone's health, lives and score. The rules and numbers are in
// ../combat.ts; this file is the bookkeeping.
//
// Messages are handled one at a time on the room's thread, in arrival order, so
// simultaneous fire resolves deterministically: whoever's shot is processed
// first lands first, and a player killed by it can no longer fire or be hit.

import type { MapId } from "../rules.js";
import type { Vec3 } from "../movement.js";
import type { MatchState, Player } from "./schema/MatchState.js";
import {
  addFocus,
  blastDamage,
  canDash,
  FOCUS,
  GRENADE,
  GUNS,
  HEALTH,
  holdWeapon,
  KILLS_TO_WIN,
  MAX_REWIND_MS,
  MELEE,
  meleeHits,
  newArms,
  ORIGIN_TOLERANCE,
  raycastBodies,
  raycastWorld,
  RANGE,
  refill,
  regen,
  RELOAD_GRACE_MS,
  RESPAWN_MS,
  scatter,
  SPIKE,
  grenadeLanding,
  zoneAt,
  AIR_SPREAD,
  type Arms,
  type Target,
} from "../combat.js";

/** Why an intent was refused (counted in `stats`, never sent to anyone). */
export type Refusal =
  | "not-playing"
  | "match-over"
  | "not-in-match"
  | "dead"
  | "duplicate-shot"
  | "bad-aim"
  | "bad-origin"
  | "unknown-weapon"
  | "too-fast"
  | "reloading"
  | "empty"
  | "no-focus"
  | "no-target"
  | "bad-hazard";

/** Sent to every client when a hit lands (one per victim per shot). */
export type HitEvent = {
  attacker: string;
  victim: string;
  weapon: string;
  /** health actually taken */
  damage: number;
  head: boolean;
  kill: boolean;
  /** where it landed, for the impact splash */
  x: number;
  y: number;
  z: number;
};

/** Sent to every client when someone goes down. `killer` is "" for no credit (self). */
export type EliminatedEvent = { victim: string; killer: string; weapon: string };

export type Aim = { origin: Vec3; dir: Vec3 };
export type FireIntent = Aim & { shot: number; weapon: string; ads: boolean; air: boolean; lag: number };
export type MeleeIntent = Aim & { shot: number; lag: number };
export type ThrowIntent = Aim & { shot: number };

/** A respawn may happen this early when the client's own timer beats ours. */
const REVIVE_EARLY_MS = 300;
/** A dead client that never re-places itself is revived anyway after this. */
const REVIVE_FALLBACK_MS = 2000;
/** Body history kept for lag compensation. */
const HISTORY_MS = MAX_REWIND_MS + 500;
/** Eye height used to check a shot's claimed origin (standing 1.6, crouched ~1.0). */
const EYE_Y = 1.3;

type Sample = { t: number; x: number; y: number; z: number; epoch: number };
type Grenade = { owner: string; at: Vec3; explodeAt: number };

export class Combat {
  /** counters for tests and diagnostics */
  stats = { accepted: 0, hits: 0, reloads: 0, refused: {} as Partial<Record<Refusal, number>> };
  /** spread randomness; tests make it deterministic */
  random: () => number = Math.random;

  private arms = new Map<string, Arms>();
  private history = new Map<string, Sample[]>();
  private respawnAt = new Map<string, number>();
  private hurtAt = new Map<string, number>();
  private grenades: Grenade[] = [];
  private lastTick = 0;
  /** eliminations wait for the hit that caused them to be announced first */
  private fallen: EliminatedEvent[] = [];

  constructor(
    private state: MatchState,
    private emit: (type: "hit" | "eliminated", message: HitEvent | EliminatedEvent) => void,
  ) {}

  /** server time, ms; tests replace it to step through cooldowns and fuses */
  clock: () => number = Date.now;
  private now() {
    return this.clock();
  }

  /* ------------------------------- lifecycle ------------------------------- */

  /** The match starts, or the host calls a rematch: full health, clean slate. */
  resetMatch() {
    const now = this.now();
    this.state.winnerId = "";
    this.grenades = [];
    this.respawnAt.clear();
    this.hurtAt.clear();
    for (const p of this.state.players.values()) {
      p.hp = HEALTH.max;
      p.alive = true;
      p.kills = 0;
      p.deaths = 0;
      this.arms.set(p.id, newArms(now, this.arms.get(p.id)?.lastShot ?? 0));
    }
  }

  /** Someone joined a match already running: they arrive standing. */
  joined(p: Player) {
    if (this.state.phase !== "playing") return;
    p.hp = HEALTH.max;
    p.alive = true;
    this.arms.set(p.id, newArms(this.now()));
  }

  /** A reloaded page starts its shot counter over. */
  reconnected(id: string) {
    const a = this.arms.get(id);
    if (a) a.lastShot = 0;
  }

  forget(id: string) {
    this.arms.delete(id);
    this.history.delete(id);
    this.respawnAt.delete(id);
    this.hurtAt.delete(id);
  }

  /** The room accepted a new position for `p` (`teleported`: a respawn, dash, door…). */
  moved(p: Player, teleported: boolean, weapon: string) {
    const now = this.now();
    const samples = this.history.get(p.id) ?? [];
    samples.push({ t: now, x: p.x, y: p.y, z: p.z, epoch: p.epoch });
    while (samples.length > 0 && samples[0].t < now - HISTORY_MS) samples.shift();
    this.history.set(p.id, samples);
    const a = this.arms.get(p.id);
    if (a && (weapon in GUNS || weapon === MELEE.name)) holdWeapon(a, weapon);
    // The dead come back when their client puts them on a spawn pad, once the
    // wait is (just about) over.
    const due = this.respawnAt.get(p.id);
    if (!p.alive && due !== undefined && teleported && now >= due - REVIVE_EARLY_MS) this.revive(p);
  }

  /** Regen, grenade fuses, and the fallback revive. Called on the room's clock. */
  tick() {
    const now = this.now();
    const dt = this.lastTick ? Math.min(0.5, (now - this.lastTick) / 1000) : 0;
    this.lastTick = now;
    for (const p of this.state.players.values()) {
      if (p.alive) p.hp = regen(p.hp, now - (this.hurtAt.get(p.id) ?? -Infinity), dt);
      const due = this.respawnAt.get(p.id);
      if (!p.alive && due !== undefined && now >= due + REVIVE_FALLBACK_MS) this.revive(p);
    }
    const due = this.grenades.filter((g) => now >= g.explodeAt);
    if (due.length) this.grenades = this.grenades.filter((g) => now < g.explodeAt);
    for (const g of due) this.explode(g);
  }

  private revive(p: Player) {
    p.alive = true;
    p.hp = HEALTH.max;
    this.respawnAt.delete(p.id);
    this.hurtAt.delete(p.id);
    // netRespawn(): fresh magazines; the focus meter carries over, as it does in the engine.
    const old = this.arms.get(p.id);
    const fresh = newArms(this.now(), old?.lastShot ?? 0);
    if (old) {
      fresh.focus = old.focus;
      fresh.slowmoUntil = old.slowmoUntil;
      fresh.chain = old.chain;
      fresh.weapon = old.weapon;
    }
    this.arms.set(p.id, fresh);
  }

  /* -------------------------------- intents -------------------------------- */

  fire(id: string, m: FireIntent) {
    const ctx = this.gate(id, m.shot, m);
    if (!ctx) return;
    const gun = GUNS[m.weapon];
    if (!gun) return this.refuse("unknown-weapon");
    const { a, now } = ctx;
    holdWeapon(a, m.weapon);
    if (a.reload?.weapon === m.weapon) return this.refuse("reloading");
    if (a.ready[m.weapon] < 1) return this.refuse("too-fast");
    if (a.mags[m.weapon] < 1) return this.refuse("empty");
    a.ready[m.weapon] -= 1;
    a.mags[m.weapon] -= 1;
    a.lastShot = m.shot;
    this.stats.accepted++;

    const spread = (m.ads ? gun.adsSpread : gun.spread) * (m.air ? AIR_SPREAD : 1);
    const zone = this.zoneOf(ctx.p);
    const rewound = this.targets(id, zone, now - clampLag(m.lag));
    const current = this.targets(id, zone, now);
    const landed: { victim: string; head: boolean; point: Vec3 }[] = [];
    for (let i = 0; i < gun.pellets; i++) {
      const dir = scatter(m.dir, spread, this.random);
      const wall = raycastWorld(zone, m.origin, dir, RANGE);
      const hit = raycastBodies(m.origin, dir, wall, rewound) ?? raycastBodies(m.origin, dir, wall, current);
      if (hit) landed.push({ victim: hit.id, head: hit.head, point: hit.point });
    }
    this.land(
      id,
      m.weapon,
      landed.map((l) => ({ ...l, damage: gun.damage * (l.head ? gun.headMul : 1) })),
    );
  }

  slash(id: string, m: MeleeIntent) {
    const ctx = this.gate(id, m.shot, m);
    if (!ctx) return;
    const { a, now } = ctx;
    holdWeapon(a, MELEE.name);
    if (a.ready[MELEE.name] < 1) return this.refuse("too-fast");
    a.ready[MELEE.name] -= 1;
    a.lastShot = m.shot;
    this.stats.accepted++;

    const zone = this.zoneOf(ctx.p);
    const rewound = this.targets(id, zone, now - clampLag(m.lag));
    const current = new Map(this.targets(id, zone, now).map((t) => [t.id, t]));
    const landed: { victim: string; head: boolean; point: Vec3; damage: number }[] = [];
    for (const t of rewound) {
      const body = [t, current.get(t.id)].find((b) => b && meleeHits(m.origin, m.dir, up(b.feet, MELEE.chestY), MELEE.reach, MELEE.cosArc));
      if (!body) continue;
      const head = meleeHits(m.origin, m.dir, up(body.feet, MELEE.headY), MELEE.reach, MELEE.headCos);
      landed.push({ victim: t.id, head, point: up(body.feet, MELEE.chestY), damage: MELEE.damage * (head ? MELEE.headMul : 1) });
    }
    this.land(id, MELEE.name, landed);
    // katanaSlash(): a landed slash charges the meter per body; a miss empties it.
    if (landed.length === 0) a.focus = 0;
    for (let i = 0; i < landed.length; i++) addFocus(a, MELEE.focusGain, now);
  }

  dash(id: string, m: MeleeIntent) {
    const ctx = this.gate(id, m.shot, m);
    if (!ctx) return;
    const { a, now } = ctx;
    if (!canDash(a, now)) return this.refuse("no-focus");
    // tryFocusDash(): the nearest body within range inside the forward cone.
    const zone = this.zoneOf(ctx.p);
    let best: { id: string; feet: Vec3; d: number } | null = null;
    for (const set of [this.targets(id, zone, now - clampLag(m.lag)), this.targets(id, zone, now)]) {
      for (const t of set) {
        const aim = up(t.feet, FOCUS.aimY);
        const to = { x: aim.x - m.origin.x, y: aim.y - m.origin.y, z: aim.z - m.origin.z };
        const d = Math.hypot(to.x, to.y, to.z);
        if (d >= FOCUS.range || d < 1e-6) continue;
        if ((to.x * m.dir.x + to.y * m.dir.y + to.z * m.dir.z) / d <= FOCUS.cos) continue;
        if (!best || d < best.d) best = { id: t.id, feet: t.feet, d };
      }
      if (best) break;
    }
    if (!best) return this.refuse("no-target");
    a.lastShot = m.shot;
    a.chain += 1;
    a.slowmoUntil = 0;
    this.stats.accepted++;
    this.land(id, MELEE.name, [{ victim: best.id, head: false, point: up(best.feet, MELEE.chestY), damage: FOCUS.damage }]);
    addFocus(a, MELEE.focusGain, now);
  }

  throwGrenade(id: string, m: ThrowIntent) {
    const ctx = this.gate(id, m.shot, m);
    if (!ctx) return;
    const { a, now, p } = ctx;
    if (now - a.grenadeAt < GRENADE.cooldown * 1000 - 50) return this.refuse("too-fast");
    a.grenadeAt = now;
    a.lastShot = m.shot;
    this.stats.accepted++;
    const { bounds } = zoneAt(this.map, { x: p.x, y: p.y, z: p.z });
    this.grenades.push({ owner: id, at: grenadeLanding(m.origin, m.dir, bounds), explodeAt: now + GRENADE.fuse * 1000 });
  }

  reload(id: string, weapon: string) {
    const p = this.state.players.get(id);
    const a = this.arms.get(id);
    if (!p || !a || !p.alive || this.state.phase !== "playing") return;
    const gun = GUNS[weapon];
    if (!gun) return this.refuse("unknown-weapon");
    holdWeapon(a, weapon);
    refill(a, this.now());
    if (a.reload || a.mags[weapon] >= gun.magSize) return;
    a.reload = { weapon, until: this.now() + gun.reloadTime * 1000 - RELOAD_GRACE_MS };
    this.stats.reloads++;
  }

  /** A spike trap the client stood on (traps run on each client's clock; see README). */
  hazard(id: string, damage: number) {
    const p = this.state.players.get(id);
    const a = this.arms.get(id);
    if (!p || !a || !p.alive || !p.spawned || this.state.phase !== "playing" || this.state.winnerId) return;
    const now = this.now();
    const zone = zoneAt(this.map, { x: p.x, y: p.y, z: p.z }).id;
    if (damage !== SPIKE.damage || zone === "surface" || zone === "district" || now - a.hazardAt < SPIKE.everyMs - 50) {
      return this.refuse("bad-hazard");
    }
    a.hazardAt = now;
    this.hurt(p, damage, id, "SPIKES");
  }

  /* ------------------------------- resolution ------------------------------- */

  /** Apply one attack's landed hits in order, one event per victim. */
  private land(attacker: string, weapon: string, hits: { victim: string; head: boolean; point: Vec3; damage: number }[]) {
    const byVictim = new Map<string, HitEvent>();
    for (const h of hits) {
      const v = this.state.players.get(h.victim);
      if (!v || !v.alive) continue;
      const before = v.hp;
      const killed = this.hurt(v, h.damage, attacker, weapon, true);
      const e = byVictim.get(h.victim) ?? {
        attacker,
        victim: h.victim,
        weapon,
        damage: 0,
        head: false,
        kill: false,
        x: h.point.x,
        y: h.point.y,
        z: h.point.z,
      };
      e.damage += before - v.hp;
      e.head ||= h.head;
      e.kill ||= killed;
      byVictim.set(h.victim, e);
    }
    for (const e of byVictim.values()) {
      this.stats.hits++;
      this.emit("hit", e);
    }
    this.announceFallen();
  }

  private announceFallen() {
    for (const e of this.fallen.splice(0)) this.emit("eliminated", e);
  }

  /**
   * Take `amount` off `v`. Returns true when it kills. With `quiet`, the
   * caller announces the hit (one event per victim per shot) and then the
   * elimination; otherwise both are announced here.
   */
  private hurt(v: Player, amount: number, attacker: string, weapon: string, quiet = false): boolean {
    if (!v.alive || amount <= 0) return false;
    const now = this.now();
    const before = v.hp;
    v.hp = Math.max(0, v.hp - amount);
    this.hurtAt.set(v.id, now);
    const kill = v.hp <= 0;
    if (kill) this.eliminate(v, attacker, weapon, now);
    if (!quiet) {
      this.stats.hits++;
      this.emit("hit", { attacker, victim: v.id, weapon, damage: before - v.hp, head: false, kill, x: v.x, y: v.y + 1, z: v.z });
      this.announceFallen();
    }
    return kill;
  }

  private eliminate(v: Player, attacker: string, weapon: string, now: number) {
    v.alive = false;
    v.deaths += 1;
    this.respawnAt.set(v.id, now + RESPAWN_MS);
    // Erasing yourself (your own grenade, a spike) is a death, not a kill.
    const killer = attacker !== v.id ? this.state.players.get(attacker) : undefined;
    if (killer) {
      killer.kills += 1;
      if (killer.kills >= KILLS_TO_WIN && !this.state.winnerId) this.state.winnerId = killer.id;
    }
    this.fallen.push({ victim: v.id, killer: killer?.id ?? "", weapon });
  }

  private explode(g: Grenade) {
    if (this.state.phase !== "playing" || this.state.winnerId) return;
    const hits: { victim: string; head: boolean; point: Vec3; damage: number }[] = [];
    for (const p of this.state.players.values()) {
      if (!p.alive || !p.connected || !p.spawned) continue;
      const damage = blastDamage(g.at, { x: p.x, y: p.y, z: p.z }, p.id === g.owner);
      if (damage > 0) hits.push({ victim: p.id, head: false, point: { x: p.x, y: p.y + 1, z: p.z }, damage });
    }
    this.land(g.owner, "GRENADE", hits);
  }

  /* --------------------------------- helpers --------------------------------- */

  private get map() {
    return this.state.map as MapId;
  }

  private zoneOf(p: Player) {
    return zoneAt(this.map, { x: p.x, y: p.y, z: p.z }).id;
  }

  /**
   * Everyone a shot from `shooter` could hit, as they stood at time `t`: alive,
   * connected, placed, in the shooter's zone (the engine never draws a body in
   * another zone). A body that has teleported since `t` is only where it is now.
   */
  private targets(shooter: string, zone: string, t: number): Target[] {
    const out: Target[] = [];
    for (const p of this.state.players.values()) {
      if (p.id === shooter || !p.alive || !p.connected || !p.spawned) continue;
      let feet: Vec3 = { x: p.x, y: p.y, z: p.z };
      const samples = this.history.get(p.id) ?? [];
      for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i].t <= t) {
          if (samples[i].epoch === p.epoch) feet = samples[i];
          break;
        }
      }
      if (zoneAt(this.map, feet).id !== zone) continue;
      out.push({ id: p.id, feet: { x: feet.x, y: feet.y, z: feet.z } });
    }
    return out;
  }

  /** Everything every attack checks first. Returns null (and counts why) when refused. */
  private gate(id: string, shot: number, aim: Aim): { p: Player; a: Arms; now: number } | null {
    if (this.state.phase !== "playing") return this.refuse("not-playing");
    if (this.state.winnerId) return this.refuse("match-over");
    const p = this.state.players.get(id);
    const a = this.arms.get(id);
    if (!p || !a || !p.connected || !p.spawned) return this.refuse("not-in-match");
    if (!p.alive) return this.refuse("dead");
    if (shot <= a.lastShot) return this.refuse("duplicate-shot");
    const len = Math.hypot(aim.dir.x, aim.dir.y, aim.dir.z);
    if (Math.abs(len - 1) > 0.02) return this.refuse("bad-aim");
    aim.dir = { x: aim.dir.x / len, y: aim.dir.y / len, z: aim.dir.z / len };
    const eye = up({ x: p.x, y: p.y, z: p.z }, EYE_Y);
    if (Math.hypot(aim.origin.x - eye.x, aim.origin.y - eye.y, aim.origin.z - eye.z) > ORIGIN_TOLERANCE) {
      return this.refuse("bad-origin");
    }
    const now = this.now();
    refill(a, now);
    return { p, a, now };
  }

  private refuse(why: Refusal): null {
    this.stats.refused[why] = (this.stats.refused[why] ?? 0) + 1;
    return null;
  }
}

const up = (p: Vec3, dy: number): Vec3 => ({ x: p.x, y: p.y + dy, z: p.z });
const clampLag = (ms: number) => Math.min(MAX_REWIND_MS, Math.max(0, ms));
