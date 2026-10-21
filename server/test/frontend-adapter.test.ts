// The browser's lobby transport (src/game/colyseus.ts), driven against this
// server under Node. This is the same class Online.tsx constructs when the
// build sets VITE_NET_TRANSPORT=colyseus, so these tests cover the frontend
// half of the lobby without a browser.
//
// Excluded from this package's `tsc` (it would type-check the frontend's
// Three.js code with the server's settings); the root `tsc -b` covers it.
import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { testServer } from "./harness.js";
import type { MatchRoom } from "../src/rooms/MatchRoom.js";
import { createServer, type Server } from "http";
import {
  ColyseusSession,
  RESUME_WINDOW_MS,
  resumableSeat,
  SEAT_KEY,
  JOIN_TIMEOUT_TEXT,
  WAKE_HINT,
  WAKE_HINT_MS,
  type ColyseusSessionDeps,
} from "../../src/game/colyseus.js";
import { matchWinner, readColyseusUrl, readNetTransport } from "../../src/game/transport.js";
import type { NetPlayerState, NetShotLanded } from "../../src/game/types.js";

const URL = "http://localhost:2568";

/** One tab's sessionStorage. */
class TabStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

async function eventually(check: () => boolean, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

type Tab = {
  session: ColyseusSession;
  storage: TabStorage;
  errors: string[];
  starts: number;
  configs: string[];
};

function open(code: string, name: string, isHost: boolean, storage = new TabStorage(), extra: ColyseusSessionDeps = {}): Tab {
  const session = new ColyseusSession(code, name, isHost, { map: "district", grapple: true }, { url: URL, storage, ...extra });
  const tab: Tab = { session, storage, errors: [], starts: 0, configs: [] };
  session.setHandlers({
    onError: (t) => tab.errors.push(t),
    onStart: () => tab.starts++,
    onConfig: (c) => tab.configs.push(c.map),
  });
  session.connect();
  return tab;
}

const count = (tab: Tab) => tab.session.getPlayers().length;

/** Close the tab's socket without a goodbye, as a reload does. */
async function reload(tab: Tab) {
  const room = (tab.session as unknown as { room: { reconnection: { enabled: boolean }; leave(c: boolean): Promise<number> } }).room;
  room.reconnection.enabled = false;
  await room.leave(false);
}

describe("frontend Colyseus lobby adapter", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const tabs: Tab[] = [];

  before(async () => (colyseus = await testServer()));
  afterEach(() => {
    for (const t of tabs.splice(0)) t.session.close();
  });
  beforeEach(async () => colyseus.cleanup());

  const tab = (code: string, name: string, isHost: boolean, storage?: TabStorage) => {
    const t = open(code, name, isHost, storage);
    tabs.push(t);
    return t;
  };

  async function hostAndGuest() {
    const h = tab("", "Ada", true);
    await eventually(() => h.session.joined && h.session.code.length === 4, "host room open");
    const g = tab(h.session.code, "Grace", false);
    await eventually(() => g.session.joined && count(h) === 2 && count(g) === 2, "both see two players");
    return { h, g };
  }

  it("reads the transport flag (PeerJS unless explicitly colyseus)", () => {
    assert.strictEqual(readNetTransport({}), "peerjs");
    assert.strictEqual(readNetTransport({ VITE_NET_TRANSPORT: "" }), "peerjs");
    assert.strictEqual(readNetTransport({ VITE_NET_TRANSPORT: "webrtc" }), "peerjs");
    assert.strictEqual(readNetTransport({ VITE_NET_TRANSPORT: " Colyseus " }), "colyseus");
    assert.strictEqual(readColyseusUrl({ DEV: true }), "http://localhost:2567");
    assert.strictEqual(readColyseusUrl({}), null, "a production build never guesses a server");
    assert.strictEqual(readColyseusUrl({ VITE_COLYSEUS_URL: "https://mp.example.com/" }), "https://mp.example.com");
    assert.strictEqual(readColyseusUrl({ VITE_COLYSEUS_URL: "mp.example.com" }), null);
  });

  it("takes the winner from the server when it names one, from the score otherwise", () => {
    const row = (id: string, kills: number, isMe = false) =>
      ({ id, name: id.toUpperCase(), ink: 0, isMe, isHost: false, kills, deaths: 0, state: {} as NetPlayerState, online: true, ready: true });
    const players = [row("a", 15), row("b", 3, true)];
    // PeerJS: no server verdict, every client counts the score itself
    assert.deepStrictEqual(matchWinner(players, undefined, 15), { id: "a", name: "A", kills: 15, isMe: false });
    assert.strictEqual(matchWinner([row("a", 14)], undefined, 15), null);
    // the server's word, not the score: undecided, decided, decided for us
    assert.strictEqual(matchWinner(players, "", 15), null);
    assert.deepStrictEqual(matchWinner(players, "b", 15), { id: "b", name: "B", kills: 3, isMe: true });
    // the winner has left, but combat stays stopped until a rematch: keep the overlay up
    assert.deepStrictEqual(matchWinner(players, "gone", 15), { id: "gone", name: "A PLAYER WHO LEFT", kills: 15, isMe: false });
  });

  it("creates a room and lets a guest join it by code", async () => {
    const { h, g } = await hostAndGuest();
    const host = h.session.getPlayers().find((p) => p.isMe);
    const guest = g.session.getPlayers().find((p) => p.isMe);
    assert.ok(host?.isHost && host.ready);
    assert.strictEqual(guest?.isHost, false);
    assert.strictEqual(guest?.ready, false);
    assert.deepStrictEqual(h.errors, []);
    assert.deepStrictEqual(g.errors, []);
  });

  it("syncs ready flags and host-only map changes", async () => {
    const { h, g } = await hostAndGuest();
    g.session.setReady(true);
    await eventually(() => h.session.getPlayers().some((p) => !p.isHost && p.ready), "host sees guest ready");

    g.session.setConfig({ map: "tomb" });
    h.session.setConfig({ map: "valley" });
    await eventually(() => g.session.getConfig().map === "valley", "guest adopts host map");
    assert.ok(!g.configs.includes("tomb"));
  });

  it("shows the server's refusal and starts only when everyone is ready", async () => {
    const { h, g } = await hostAndGuest();
    h.session.beginMatch();
    await eventually(() => h.errors.length === 1, "refusal shown");
    assert.match(h.errors[0], /ready/i);
    assert.strictEqual(h.starts + g.starts, 0);

    g.session.setReady(true);
    await eventually(() => h.session.getPlayers().some((p) => !p.isHost && p.ready), "guest ready");
    h.session.beginMatch();
    await eventually(() => h.starts === 1 && g.starts === 1, "both start");
  });

  it("explains an unknown code and a full room", async () => {
    const lost = tab("ZZZZ", "Grace", false);
    await eventually(() => lost.errors.length === 1, "unknown code reported");
    assert.match(lost.errors[0], /No match with code ZZZZ/);

    const { h } = await hostAndGuest();
    for (const name of ["Linus", "Ken"]) {
      const t = tab(h.session.code, name, false);
      await eventually(() => t.session.joined, `${name} joined`);
    }
    const fifth = tab(h.session.code, "Dennis", false);
    await eventually(() => fifth.errors.length === 1, "full room reported");
    assert.match(fifth.errors[0], /full/i);
  });

  it("resumes the same seat after a reload, with no duplicate", async () => {
    const { h, g } = await hostAndGuest();
    g.session.setReady(true);
    await eventually(() => h.session.getPlayers().some((p) => !p.isHost && p.ready), "guest ready");
    const id = g.session.me;

    await reload(g);
    await eventually(() => h.session.getPlayers().some((p) => p.id === id && !p.online), "seat held");
    const again = tab(h.session.code, "Grace", false, g.storage);
    await eventually(() => again.session.joined, "reloaded tab back in");
    assert.strictEqual(again.session.me, id);
    await eventually(() => h.session.getPlayers().some((p) => p.id === id && p.online), "seat online again");
    assert.strictEqual(count(h), 2);
    assert.strictEqual(again.session.getPlayers().find((p) => p.isMe)?.ready, true);
  });

  it("joins fresh when the held seat has expired", async () => {
    const { h, g } = await hostAndGuest();
    colyseus.getRoomById<MatchRoom>(h.session.code).reconnectSeconds = 0.2;
    const id = g.session.me;

    await reload(g);
    await eventually(() => count(h) === 1, "seat released");
    const again = tab(h.session.code, "Grace", false, g.storage);
    await eventually(() => again.session.joined, "rejoined");
    assert.notStrictEqual(again.session.me, id);
    await eventually(() => count(h) === 2, "host sees the fresh seat");
    assert.deepStrictEqual(again.errors, []);
  });

  it("marks the seat on unload so the next load can resume it inside the window", async () => {
    const { h, g } = await hostAndGuest();
    const id = g.session.me;
    assert.strictEqual(resumableSeat(g.storage, Date.now()), null, "an open page is not resumable");

    g.session.suspend(); // pagehide on a real unload
    await reload(g);
    const held = resumableSeat(g.storage, Date.now());
    assert.deepStrictEqual(held, { code: h.session.code, isHost: false });
    assert.strictEqual(resumableSeat(g.storage, Date.now() + RESUME_WINDOW_MS + 1), null, "stale after the window");

    const back = open(held!.code, "Grace", held!.isHost, g.storage, { resumeOnly: true });
    tabs.push(back);
    await eventually(() => back.session.joined, "resumed without a URL");
    assert.strictEqual(back.session.me, id);
    assert.strictEqual(resumableSeat(g.storage, Date.now()), null, "an open page is not resumable again");
    await eventually(() => count(h) === 2, "no duplicate");
  });

  it("does not open a new room when a resume-only seat has expired", async () => {
    const { h, g } = await hostAndGuest();
    colyseus.getRoomById<MatchRoom>(h.session.code).reconnectSeconds = 0.2;
    g.session.suspend();
    await reload(g);
    await eventually(() => count(h) === 1, "seat released");

    const back = open(h.session.code, "Grace", false, g.storage, { resumeOnly: true });
    tabs.push(back);
    await eventually(() => back.errors.length === 1, "expiry reported");
    assert.match(back.errors[0], /expired/);
    assert.strictEqual(back.session.joined, false);
    assert.strictEqual(count(h), 1, "no fresh seat was taken");
  });

  it("gives the seat up and forgets it on LEAVE", async () => {
    const { h, g } = await hostAndGuest();
    assert.ok(g.storage.getItem(SEAT_KEY));
    g.session.close();
    await eventually(() => count(h) === 1, "guest gone at once");
    assert.strictEqual(g.storage.getItem(SEAT_KEY), null);
  });

  describe("in the arena", () => {
    const serverRoom = (code: string) => colyseus.getRoomById<MatchRoom>(code);

    /** What the engine's netState() would return; tests move it by hand. */
    const engineBody = (over: Partial<NetPlayerState> = {}): NetPlayerState => ({
      x: 0,
      y: 0.2,
      z: 0,
      yaw: 0,
      pitch: 0,
      hp: 100,
      alive: true,
      moving: false,
      firing: false,
      weapon: "RIFLE",
      epoch: 1,
      seq: 0,
      ...over,
    });

    type Arena = {
      bodies: Map<string, NetPlayerState>;
      gone: string[];
      body: NetPlayerState;
      landed: NetShotLanded[];
      hurt: { damage: number; killer: string | null }[];
      health: { hp: number; alive: boolean; killer: string | null }[];
      feed: string[];
      rematches: number;
    };

    /** What PvpMatch does on mount: install the arena handlers and start ticking. */
    function enterArena(t: Tab, body: NetPlayerState): Arena {
      const arena: Arena = { bodies: new Map(), gone: [], body, landed: [], hurt: [], health: [], feed: [], rematches: 0 };
      t.session.setStateProvider(() => arena.body);
      t.session.startTicking();
      t.session.setHandlers({
        onRemoteState: (id, s) => arena.bodies.set(id, s),
        onPeerGone: (id) => {
          arena.gone.push(id);
          arena.bodies.delete(id);
        },
        onShotLanded: (hit) => arena.landed.push(hit),
        onHurt: (damage, killer) => arena.hurt.push({ damage, killer }),
        onHealth: (hp, alive, killer) => arena.health.push({ hp, alive, killer }),
        onFeed: (text) => arena.feed.push(text),
        onRematch: () => arena.rematches++,
      });
      return arena;
    }

    async function started() {
      const { h, g } = await hostAndGuest();
      g.session.setReady(true);
      await eventually(() => h.session.getPlayers().some((p) => !p.isHost && p.ready), "guest ready");
      h.session.beginMatch();
      await eventually(() => h.starts === 1 && g.starts === 1, "both start");
      return { h, g };
    }

    const close = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-3;

    it("shows each player the other's body, and follows it as it moves", async () => {
      const { h, g } = await started();
      const ha = enterArena(h, engineBody({ x: -5 }));
      const ga = enterArena(g, engineBody({ x: 5, yaw: 1 }));
      const gid = g.session.me;
      const hid = h.session.me;

      await eventually(() => close(ha.bodies.get(gid)?.x, 5), "host sees the guest");
      await eventually(() => close(ga.bodies.get(hid)?.x, -5), "guest sees the host");
      assert.ok(close(ha.bodies.get(gid)?.yaw, 1));
      assert.ok(!ha.bodies.has(hid), "our own body is never drawn as a remote");

      ga.body = engineBody({ x: 7, z: 2, yaw: -1, moving: true, weapon: "KATANA" });
      await eventually(() => close(ha.bodies.get(gid)?.x, 7), "host sees the guest move");
      const seen = ha.bodies.get(gid)!;
      assert.ok(close(seen.z, 2) && close(seen.yaw, -1));
      assert.strictEqual(seen.moving, true);
      assert.strictEqual(seen.weapon, "KATANA");
      assert.strictEqual(seen.epoch, 1, "walking is not a teleport");
    });

    it("hands a late arena every body already standing still", async () => {
      const { h, g } = await started();
      enterArena(g, engineBody({ x: 3 }));
      await eventually(() => serverRoom(h.session.code).state.players.get(g.session.me)?.spawned === true, "guest placed");
      await new Promise((r) => setTimeout(r, 300)); // no patches about the guest any more
      const ha = enterArena(h, engineBody());
      assert.ok(close(ha.bodies.get(g.session.me)?.x, 3), "delivered at once, not on the next move");
    });

    it("reports a player who leaves exactly once", async () => {
      const { h, g } = await started();
      const ha = enterArena(h, engineBody());
      enterArena(g, engineBody({ x: 4 }));
      const gid = g.session.me;
      await eventually(() => ha.bodies.has(gid), "guest drawn");
      g.session.close();
      await eventually(() => ha.gone.includes(gid), "guest reported gone");
      await new Promise((r) => setTimeout(r, 200));
      assert.deepStrictEqual(ha.gone, [gid]);
      assert.strictEqual(ha.bodies.size, 0);
    });

    it("hides a dropped player and brings back one body after a reload", async () => {
      const { h, g } = await started();
      const ha = enterArena(h, engineBody());
      enterArena(g, engineBody({ x: 4 }));
      const gid = g.session.me;
      await eventually(() => ha.bodies.has(gid), "guest drawn");

      g.session.suspend();
      await reload(g);
      await eventually(() => ha.gone.includes(gid), "dropped player hidden");

      // the reloaded page: a fresh engine whose epoch counter starts over
      const back = open(h.session.code, "Grace", false, g.storage, { resumeOnly: true });
      tabs.push(back);
      await eventually(() => back.session.joined, "resumed");
      assert.strictEqual(back.session.me, gid);
      enterArena(back, engineBody({ x: -20, epoch: 1 }));
      await eventually(() => close(ha.bodies.get(gid)?.x, -20), "back where the new engine put it");
      assert.ok((ha.bodies.get(gid)?.epoch ?? 0) >= 2, "a new epoch, so the arena snaps instead of sliding");
      assert.strictEqual(ha.bodies.size, 1);
      assert.strictEqual(count(h), 2);
    });

    describe("combat", () => {
      // a clear stretch of street in the district (server/test/combat-room.test.ts checks it)
      const A = { x: 0, y: 0.2, z: 38 };
      const B = { x: 0, y: 0.2, z: 30 };
      const eye = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y + 1.6, z: p.z });
      const toward = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => {
        const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
        const l = Math.hypot(d.x, d.y, d.z);
        return { x: d.x / l, y: d.y / l, z: d.z / l };
      };
      /** What the engine emits when it fires at a point (the server rolls the spread). */
      const shootAt = (t: Tab, from: typeof A, at: typeof A, weapon = "RIFLE") =>
        t.session.reportCombat({ kind: "fire", weapon, origin: eye(from), dir: toward(eye(from), at), ads: true, air: false });

      async function armed() {
        const { h, g } = await started();
        const ha = enterArena(h, engineBody({ ...A }));
        const ga = enterArena(g, engineBody({ ...B }));
        await eventually(() => ha.bodies.has(g.session.me) && ga.bodies.has(h.session.me), "both placed");
        return { h, g, ha, ga };
      }

      it("sends fire as intent and routes the server's verdict to both arenas", async () => {
        const { h, g, ha, ga } = await armed();
        shootAt(h, A, { x: B.x, y: B.y + 1, z: B.z });
        await eventually(() => ha.landed.length === 1 && ga.hurt.length === 1, "shooter's hitmarker and victim's hurt");
        assert.deepStrictEqual([ha.landed[0].head, ha.landed[0].kill, ha.landed[0].focus], [false, false, false]);
        assert.deepStrictEqual(ga.hurt[0], { damage: 9, killer: h.session.me });
        await eventually(() => ga.health.at(-1)?.hp === 91, "victim's health synced");
        assert.strictEqual(ga.health.at(-1)?.alive, true);
        assert.strictEqual(ha.hurt.length, 0, "the shooter is not hurt");
        await eventually(() => ha.bodies.get(g.session.me)?.hp === 91, "the shooter sees the victim's health");
      });

      it("reports a kill: health, killer, score and feed agree", async () => {
        const { h, g, ha, ga } = await armed();
        h.session.reportCombat({ kind: "fire", weapon: "SNIPER", origin: eye(A), dir: toward(eye(A), { x: B.x, y: B.y + 1.52, z: B.z }), ads: true, air: false });
        await eventually(() => ga.health.some((x) => !x.alive), "victim down");
        assert.deepStrictEqual(ga.health.find((x) => !x.alive), { hp: 0, alive: false, killer: h.session.me });
        assert.strictEqual(ha.landed.at(-1)?.kill, true);
        await eventually(() => h.session.getPlayers().find((p) => p.isMe)?.kills === 1, "score");
        assert.strictEqual(g.session.getPlayers().find((p) => p.isMe)?.deaths, 1);
        assert.deepStrictEqual(ga.feed.filter((t) => t.includes("ERASED")), [], "the victim writes their own obituary");
      });

      it("drops a non-finite intent instead of getting itself disconnected", async () => {
        const { h, ga } = await armed();
        h.session.reportCombat({ kind: "fire", weapon: "RIFLE", origin: { x: Number.NaN, y: 1, z: 1 }, dir: { x: 0, y: 0, z: -1 }, ads: false, air: false });
        await new Promise((r) => setTimeout(r, 200));
        assert.strictEqual(h.session.joined, true);
        assert.strictEqual(ga.hurt.length, 0);
      });

      it("restarts both arenas on the host's rematch, with a clean score", async () => {
        const { h, g, ha, ga } = await armed();
        h.session.reportCombat({ kind: "fire", weapon: "SNIPER", origin: eye(A), dir: toward(eye(A), { x: B.x, y: B.y + 1.52, z: B.z }), ads: true, air: false });
        await eventually(() => h.session.getPlayers().find((p) => p.isMe)?.kills === 1, "a kill on the board");
        g.session.rematch(); // a guest cannot
        h.session.rematch();
        await eventually(() => ha.rematches === 1 && ga.rematches === 1, "both restart");
        await eventually(() => h.session.getPlayers().every((p) => p.kills === 0 && p.deaths === 0), "score cleared");
      });

      it("shows both arenas the server's winner, and clears it on rematch", async () => {
        const { h, g, ha, ga } = await armed();
        const hid = h.session.me;
        serverRoom(h.session.code).state.players.get(hid)!.kills = 14;
        await eventually(() => g.session.getPlayers().find((p) => p.id === hid)?.kills === 14, "fourteen on the board");
        assert.strictEqual(g.session.winnerId, "", "undecided");
        let changes = 0;
        g.session.setHandlers({ onChange: () => changes++ });
        h.session.reportCombat({ kind: "fire", weapon: "SNIPER", origin: eye(A), dir: toward(eye(A), { x: B.x, y: B.y + 1.52, z: B.z }), ads: true, air: false });
        await eventually(() => h.session.winnerId === hid && g.session.winnerId === hid, "both told who won");
        assert.ok(changes > 0, "the arena re-renders for the result");
        assert.deepStrictEqual(matchWinner(g.session.getPlayers(), g.session.winnerId, 15), { id: hid, name: "Ada", kills: 15, isMe: false });
        assert.strictEqual(matchWinner(h.session.getPlayers(), h.session.winnerId, 15)?.isMe, true);
        h.session.rematch();
        await eventually(() => ha.rematches === 1 && ga.rematches === 1, "both restart");
        await eventually(() => h.session.winnerId === "" && g.session.winnerId === "", "result cleared");
      });

      it("lets a guest promoted to host call the rematch", async () => {
        const { h, g, ga } = await armed();
        const gid = g.session.me;
        h.session.close();
        await eventually(() => g.session.getPlayers().find((p) => p.isMe)?.isHost === true, "guest promoted");
        assert.strictEqual(g.session.isHost, false, "it joined as a guest; the roster says who hosts now");
        g.session.rematch();
        await eventually(() => ga.rematches === 1, "the promoted host's rematch runs");
        assert.strictEqual(serverRoom(g.session.code).state.hostId, gid);
      });
    });

    it("skips a non-finite frame instead of getting itself disconnected", async () => {
      const { h, g } = await started();
      const ga = enterArena(g, engineBody({ x: Number.NaN }));
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(g.session.joined, true);
      assert.strictEqual(serverRoom(h.session.code).state.players.get(g.session.me)?.spawned, false);
      ga.body = engineBody({ x: 2 });
      await eventually(() => serverRoom(h.session.code).state.players.get(g.session.me)?.spawned === true, "placed");
    });
  });

  it("explains a slow matchmaker (a host waking up) instead of waiting in silence", async function () {
    this.timeout(WAKE_HINT_MS + 10_000);
    // accepts the request and never answers, like a free-tier host spinning up
    const sleepy: Server = createServer(() => {});
    await new Promise<void>((r) => sleepy.listen(0, "127.0.0.1", () => r()));
    const { port } = sleepy.address() as { port: number };
    const statuses: string[] = [];
    const session = new ColyseusSession("", "Ada", true, { map: "district", grapple: true }, { url: `http://127.0.0.1:${port}`, storage: new TabStorage() });
    session.setHandlers({ onStatus: (t) => statuses.push(t) });
    try {
      session.connect();
      await new Promise((r) => setTimeout(r, WAKE_HINT_MS - 1000));
      assert.ok(!statuses.includes(WAKE_HINT), "not before the grace period");
      await eventually(() => statuses.includes(WAKE_HINT), "wake hint", 3000);
    } finally {
      session.close();
      sleepy.closeAllConnections();
      await new Promise((r) => sleepy.close(r));
    }
  });

  it("gives up on a server that never answers, says so, and asks for nothing more", async () => {
    let requests = 0;
    const silent: Server = createServer(() => void requests++);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const { port } = silent.address() as { port: number };
    const lost: string[] = [];
    const session = new ColyseusSession("ABCD", "Ada", false, { map: "district", grapple: true }, {
      url: `http://127.0.0.1:${port}`,
      storage: new TabStorage(),
      joinTimeoutMs: 400,
    });
    session.setHandlers({ onLost: (t) => lost.push(t) });
    try {
      session.connect();
      await eventually(() => lost.length === 1, "timed out", 3000);
      assert.strictEqual(lost[0], JOIN_TIMEOUT_TEXT);
      assert.strictEqual(session.phase, "closed");
      assert.strictEqual(session.joined, false);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(requests, 1, "one join request, never repeated");
      assert.strictEqual(lost.length, 1, "reported once");
    } finally {
      session.close();
      silent.closeAllConnections();
      await new Promise((r) => silent.close(r));
    }
  });

  it("ends the session for good, and says why, when the server restarts", async () => {
    const { h, g } = await hostAndGuest();
    const lost: string[] = [];
    for (const t of [h, g]) t.session.setHandlers({ onLost: (text) => lost.push(text) });
    // what SIGTERM does to every room (matchMaker.gracefullyShutdown)
    await colyseus.getRoomById<MatchRoom>(h.session.code).disconnect(4001);
    await eventually(() => lost.length === 2, "both sessions lost");
    for (const text of lost) assert.match(text, /match server restarted/);
    for (const t of [h, g]) {
      assert.strictEqual(t.storage.getItem(SEAT_KEY), null, "no seat to resume on a server that no longer has it");
      assert.strictEqual(t.session.phase, "closed");
    }
  });

  it("says so when the build has no server URL", async () => {
    const session = new ColyseusSession("", "Ada", true, { map: "district", grapple: true }, { url: null, storage: null });
    const errors: string[] = [];
    session.setHandlers({ onError: (t) => errors.push(t) });
    session.connect();
    await eventually(() => errors.length === 1, "missing URL reported");
    assert.match(errors[0], /VITE_COLYSEUS_URL/);
  });
});
