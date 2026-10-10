// Online play — peer-to-peer free-for-all over WebRTC data channels.
//
// The transport is PeerJS: the public broker only introduces the browsers to
// each other and is never asked to run the game. After that first handshake
// every packet travels straight from player to player, which is what keeps a
// match playable without a game server.
//
// Topology is a star through the host: guests dial the host, and the host
// relays. That means one code to share, one connection per guest, and a single
// place where the roster lives.
//
// Authority is deliberately split the way a casual shooter does it: every
// player is authoritative over their own body (position, health, whether they
// are down), while the shooter is the one who decides their bullet connected.
// A hit is therefore reported by the client that fired it and applied by the
// client that took it — the only client whose opinion about its own health
// counts.

import Peer, { type DataConnection } from "peerjs";
import type { NetPlayerState } from "./types";

/** One player as the lobby and the scoreboard see them. */
export type NetPlayer = {
  id: string;
  name: string;
  /** ink palette index, so every player reads as a different doodle */
  ink: number;
  isMe: boolean;
  isHost: boolean;
  kills: number;
  deaths: number;
  state: NetPlayerState;
  /** false once their state stops arriving (closed tab, lost connection, …) */
  online: boolean;
};

type RosterEntry = { id: string; name: string; ink: number };

type NetMsg =
  | { t: "hello"; name: string }
  | { t: "roster"; list: RosterEntry[] }
  | { t: "state"; s: NetPlayerState }
  | { t: "hit"; victim: string; dmg: number }
  | { t: "death"; killer: string }
  | { t: "respawn" }
  | { t: "start" }
  | { t: "bye" };

type Envelope = NetMsg & { from: string; name?: string; ink?: number };

export type NetHandlers = {
  /** a remote player's transform arrived — hand it straight to the engine */
  onRemoteState?: (id: string, state: NetPlayerState) => void;
  /** someone's shot landed on us (killerId is the shooter's peer id) */
  onHitMe?: (dmg: number, killerId: string) => void;
  onDeath?: (victimId: string, killerId: string) => void;
  onRespawn?: (id: string) => void;
  /** the host said go */
  onStart?: () => void;
  onFeed?: (text: string, hot: boolean) => void;
  onStatus?: (text: string) => void;
  onError?: (text: string) => void;
  /** the roster or a score changed — re-render */
  onChange?: () => void;
};

const PREFIX = "ds-pvp-";

const IDLE: NetPlayerState = {
  x: 0, y: 0.2, z: 38, yaw: Math.PI, pitch: 0,
  hp: 120, alive: false, moving: false, firing: false, weapon: "RIFLE",
};

/** A short, readable, unambiguous room code (no O/0, no I/1). */
export function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export class NetSession {
  readonly code: string;
  readonly isHost: boolean;
  name: string;
  /** our own peer id, known once the broker accepts us */
  me = "";
  phase: "connecting" | "lobby" | "playing" | "closed" = "connecting";

  /** page callbacks — always installed through setHandlers() */
  private handlers: NetHandlers = {};
  /** where our own state comes from, polled 20× a second */
  private stateProvider: (() => NetPlayerState) | null = null;

  /**
   * Install (or replace) the page's callbacks. Deliberately a method rather
   * than a public field: React treats props as immutable, and a page assigning
   * into `session.handlers` is exactly the kind of mutation that makes the
   * compiler's assumptions wrong.
   */
  setHandlers(patch: NetHandlers) {
    Object.assign(this.handlers, patch);
  }

  /** Hand the net layer the function that reads our own transform. */
  setStateProvider(fn: (() => NetPlayerState) | null) {
    this.stateProvider = fn;
  }

  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  private roster = new Map<string, { name: string; ink: number }>();
  private scores = new Map<string, { kills: number; deaths: number }>();
  private lastState: Record<string, NetPlayerState> = {};
  private lastSeen = new Map<string, number>();
  private sendTimer = 0;
  private snapshot: NetPlayer[] = [];

  constructor(code: string, name: string, isHost: boolean) {
    this.code = code.toUpperCase();
    this.name = name.trim().slice(0, 16) || (isHost ? "HOST" : "GUEST");
    this.isHost = isHost;
  }

  /** The host answers to a predictable id, so a code is all a guest needs. */
  get hostId() {
    return PREFIX + this.code;
  }

  /* ------------------------------- lifecycle ------------------------------- */

  connect() {
    if (this.isHost) {
      const peer = new Peer(this.hostId, { debug: 0 });
      this.peer = peer;
      peer.on("open", (id) => {
        this.me = id;
        this.roster.set(id, { name: this.name, ink: 0 });
        this.phase = "lobby";
        this.handlers.onStatus?.("WAITING FOR YOUR FRIEND…");
        this.publish();
      });
      peer.on("connection", (conn) => this.adopt(conn));
      peer.on("disconnected", () => {
        // The broker drops us when its socket blips; a live match must not.
        if (this.phase !== "closed") peer.reconnect();
      });
      peer.on("error", (err) => this.fail(err));
      return;
    }

    const peer = new Peer({ debug: 0 });
    this.peer = peer;
    peer.on("open", (id) => {
      this.me = id;
      const conn = peer.connect(this.hostId, { reliable: true });
      const giveUp = window.setTimeout(() => {
        if (this.phase === "connecting") this.handlers.onError?.("Could not find that match. Check the code and try again.");
      }, 20000);
      conn.on("open", () => {
        window.clearTimeout(giveUp);
        this.conns.set(this.hostId, conn);
        this.roster.set(this.hostId, { name: "HOST", ink: 0 });
        this.roster.set(this.me, { name: this.name, ink: 1 });
        this.phase = "lobby";
        this.send({ t: "hello", name: this.name });
        this.handlers.onStatus?.("CONNECTED — WAITING FOR THE HOST TO START…");
        this.publish();
      });
      conn.on("data", (d) => this.receive(this.hostId, d));
      conn.on("close", () => this.drop(this.hostId));
      conn.on("error", () => this.drop(this.hostId));
    });
    peer.on("disconnected", () => {
      if (this.phase !== "closed") peer.reconnect();
    });
    peer.on("error", (err) => this.fail(err));
  }

  close() {
    if (this.phase === "closed") return;
    try {
      this.send({ t: "bye" });
    } catch {
      /* the socket is already gone */
    }
    this.phase = "closed";
    window.clearInterval(this.sendTimer);
    this.peer?.destroy();
    this.peer = null;
    this.conns.clear();
  }

  /* ------------------------------- messaging ------------------------------- */

  private fail(err: { type?: string; message?: string }) {
    const type = err?.type ?? "";
    const text =
      type === "unavailable-id"
        ? "That match code is already taken — try creating another match."
        : type === "peer-unavailable"
          ? "Could not find that match. Check the code and try again."
          : type === "network" || type === "server-error" || type === "socket-error"
            ? "The connection broker is unreachable. Try again in a moment."
            : type === "browser-incompatible"
              ? "This browser cannot do WebRTC, so online play is unavailable here."
              : err?.message || "Connection failed.";
    this.handlers.onError?.(text);
  }

  private adopt(conn: DataConnection) {
    const register = () => {
      if (!this.conns.has(conn.peer)) this.conns.set(conn.peer, conn);
    };
    if (conn.open) register();
    else conn.on("open", register);
    conn.on("data", (d) => this.receive(conn.peer, d));
    conn.on("close", () => this.drop(conn.peer));
    conn.on("error", () => this.drop(conn.peer));
  }

  private drop(id: string) {
    const had = this.conns.has(id) || this.roster.has(id);
    if (!had) return;
    const gone = this.roster.get(id)?.name ?? "A PLAYER";
    this.conns.delete(id);
    this.roster.delete(id);
    delete this.lastState[id];
    this.lastSeen.delete(id);
    this.scores.delete(id);
    if (id !== this.me && this.phase !== "closed") this.handlers.onFeed?.(`${gone} LEFT THE MATCH`, false);
    if (this.isHost) this.sendRoster();
    this.publish();
  }

  private send(msg: NetMsg, conn?: DataConnection) {
    const env: Envelope = { ...msg, from: this.me, name: this.name, ink: this.roster.get(this.me)?.ink ?? 0 };
    if (conn) {
      if (conn.open) conn.send(env);
      return;
    }
    for (const c of this.conns.values()) if (c.open) c.send(env);
  }

  /** Hand a message on untouched — the sender's id has to survive the trip. */
  private forward(env: Envelope, conn?: DataConnection) {
    if (conn) {
      if (conn.open) conn.send(env);
      return;
    }
    for (const c of this.conns.values()) if (c.open) c.send(env);
  }

  private sendRoster() {
    const list: RosterEntry[] = [...this.roster.entries()].map(([id, v]) => ({ id, name: v.name, ink: v.ink }));
    this.forward({ t: "roster", list, from: this.me });
  }

  /** Host: everybody but the sender. Guest: the host. */
  private relayToOthers(sender: string, env: Envelope) {
    for (const [id, c] of this.conns) {
      if (id === sender) continue;
      if (c.open) c.send(env);
    }
  }

  private receive(from: string, raw: unknown) {
    const env = raw as Envelope;
    if (!env || typeof env.t !== "string") return;
    this.lastSeen.set(from, performance.now());

    if (!this.isHost) {
      // A guest hears every peer through the host, already routed to them — so
      // the sender is whoever put the envelope together, not the host in front
      // of it. Reading `from` here would file every other guest under the
      // host's id the moment a third player joins.
      const src = env.from || from;
      if (env.t === "roster") {
        // the host's list is the truth: replace ours wholesale so a player who
        // left does not linger on the scoreboard
        const list = Array.isArray(env.list) ? env.list : [];
        this.roster.clear();
        for (const r of list) this.roster.set(r.id, { name: r.name, ink: r.ink });
        if (!this.roster.has(this.me)) this.roster.set(this.me, { name: this.name, ink: 1 });
        this.publish();
        return;
      }
      if (env.t === "state") {
        this.applyState(src, env.s);
        return;
      }
      if (env.t === "hit") {
        if (env.victim === this.me) this.takeHit(env.dmg, src);
        return;
      }
      this.apply(src, env);
      return;
    }

    /* -------------------------- host: the hub -------------------------- */
    if (env.t === "hello") {
      this.roster.set(from, { name: String(env.name ?? "PLAYER").slice(0, 16), ink: this.freeInk(from) });
      this.lastState[from] = this.lastState[from] ?? { ...IDLE };
      this.handlers.onFeed?.(`${this.roster.get(from)?.name ?? "A PLAYER"} JOINED`, false);
      this.sendRoster();
      // A friend who turns up mid-match drops straight into the arena with
      // everyone else instead of waiting for a start that already happened.
      if (this.phase === "playing") this.send({ t: "start" }, this.conns.get(from));
      this.publish();
      return;
    }
    if (env.t === "hit") {
      // A hit only ever interests one person: the one who took it.
      if (env.victim === this.me) this.takeHit(env.dmg, from);
      else this.forward(env, this.conns.get(env.victim));
      return;
    }
    if (env.t === "state") {
      this.applyState(from, env.s);
      this.relayToOthers(from, env);
      return;
    }
    this.apply(from, env);
    if (env.t !== "bye") this.relayToOthers(from, env);
  }

  private freeInk(id: string) {
    const used = new Set([...this.roster.entries()].filter(([k]) => k !== id).map(([, v]) => v.ink));
    for (let i = 0; i < 6; i++) if (!used.has(i)) return i;
    return this.roster.size % 6;
  }

  private applyState(id: string, s: NetPlayerState) {
    if (!s || typeof s.x !== "number" || typeof s.hp !== "number") return;
    this.lastState[id] = s;
    this.handlers.onRemoteState?.(id, s);
  }

  private apply(from: string, env: Envelope) {
    const who = this.roster.get(from)?.name ?? "A PLAYER";
    switch (env.t) {
      case "death": {
        this.bump(env.killer, { kills: 1 });
        this.bump(from, { deaths: 1 });
        const killer = this.roster.get(env.killer)?.name;
        this.handlers.onFeed?.(
          env.killer === from ? `${who} ERASED THEMSELVES` : `${killer ?? "SOMEONE"} ERASED ${who}`,
          env.killer === this.me || from === this.me,
        );
        this.handlers.onDeath?.(from, env.killer);
        this.publish();
        break;
      }
      case "respawn":
        this.handlers.onRespawn?.(from);
        this.publish();
        break;
      case "start":
        this.phase = "playing";
        this.handlers.onStart?.();
        break;
      case "bye":
        this.drop(from);
        break;
      default:
        break;
    }
  }

  private bump(id: string, add: { kills?: number; deaths?: number }) {
    if (!id) return;
    const cur = this.scores.get(id) ?? { kills: 0, deaths: 0 };
    this.scores.set(id, { kills: cur.kills + (add.kills ?? 0), deaths: cur.deaths + (add.deaths ?? 0) });
  }

  private takeHit(dmg: number, killer: string) {
    this.handlers.onHitMe?.(dmg, killer);
  }

  /* -------------------------------- actions -------------------------------- */

  /** Called from the shooter's engine when a round lands on a remote player. */
  reportHit(victim: string, dmg: number) {
    if (victim === this.me || this.phase !== "playing") return;
    this.send({ t: "hit", victim, dmg });
  }

  reportDeath(killer: string) {
    this.send({ t: "death", killer });
    this.bump(this.me, { deaths: 1 });
    if (killer && killer !== this.me) this.bump(killer, { kills: 1 });
    else this.bump(this.me, { kills: 1 });
    this.publish();
  }

  reportRespawn() {
    this.send({ t: "respawn" });
  }

  /** Host only: everyone drops into the arena together. */
  beginMatch() {
    this.phase = "playing";
    this.send({ t: "start" });
    this.handlers.onStart?.();
  }

  /** Push our transform to the room 20× a second. */
  startTicking() {
    window.clearInterval(this.sendTimer);
    this.sendTimer = window.setInterval(() => {
      if (this.phase === "closed" || !this.stateProvider) return;
      this.send({ t: "state", s: this.stateProvider() });
    }, 50);
  }

  /* --------------------------------- roster --------------------------------- */

  getPlayers(): NetPlayer[] {
    return this.snapshot;
  }

  private publish() {
    const list: NetPlayer[] = [];
    for (const [id, info] of this.roster) list.push(this.row(id, info));
    list.sort((a, b) => Number(b.isHost) - Number(a.isHost) || b.kills - a.kills);
    this.snapshot = list;
    this.handlers.onChange?.();
  }

  private row(id: string, info: { name: string; ink: number }): NetPlayer {
    const score = this.scores.get(id) ?? { kills: 0, deaths: 0 };
    return {
      id,
      name: info.name,
      ink: info.ink,
      isMe: id === this.me,
      isHost: id === (this.isHost ? this.me : this.hostId),
      kills: score.kills,
      deaths: score.deaths,
      state: this.lastState[id] ?? { ...IDLE },
      online: id === this.me || performance.now() - (this.lastSeen.get(id) ?? 0) < 4000,
    };
  }
}
