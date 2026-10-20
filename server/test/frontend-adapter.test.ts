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
import { ColyseusSession, RESUME_WINDOW_MS, resumableSeat, SEAT_KEY, type ColyseusSessionDeps } from "../../src/game/colyseus.js";
import { readColyseusUrl, readNetTransport } from "../../src/game/transport.js";
import type { NetPlayerState } from "../../src/game/types.js";

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
      hp: 120,
      alive: true,
      moving: false,
      firing: false,
      weapon: "RIFLE",
      epoch: 1,
      seq: 0,
      ...over,
    });

    type Arena = { bodies: Map<string, NetPlayerState>; gone: string[]; body: NetPlayerState };

    /** What PvpMatch does on mount: install the arena handlers and start ticking. */
    function enterArena(t: Tab, body: NetPlayerState): Arena {
      const arena: Arena = { bodies: new Map(), gone: [], body };
      t.session.setStateProvider(() => arena.body);
      t.session.startTicking();
      t.session.setHandlers({
        onRemoteState: (id, s) => arena.bodies.set(id, s),
        onPeerGone: (id) => {
          arena.gone.push(id);
          arena.bodies.delete(id);
        },
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

  it("says so when the build has no server URL", async () => {
    const session = new ColyseusSession("", "Ada", true, { map: "district", grapple: true }, { url: null, storage: null });
    const errors: string[] = [];
    session.setHandlers({ onError: (t) => errors.push(t) });
    session.connect();
    await eventually(() => errors.length === 1, "missing URL reported");
    assert.match(errors[0], /VITE_COLYSEUS_URL/);
  });
});
