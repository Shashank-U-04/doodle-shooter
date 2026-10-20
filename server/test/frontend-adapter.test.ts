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

  it("says so when the build has no server URL", async () => {
    const session = new ColyseusSession("", "Ada", true, { map: "district", grapple: true }, { url: null, storage: null });
    const errors: string[] = [];
    session.setHandlers({ onError: (t) => errors.push(t) });
    session.connect();
    await eventually(() => errors.length === 1, "missing URL reported");
    assert.match(errors[0], /VITE_COLYSEUS_URL/);
  });
});
