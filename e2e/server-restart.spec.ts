// A lost connection in a real browser: a network problem must never be called a
// server restart, and a real restart must not take a minute and a half to report.
//
// These are simulations of the hosting path. Each player's room socket runs
// through a bridge in this test process, which can kill it with nothing delivered
// (no notice, no close: what two restarts on Render looked like on 2026-11-02) and
// refuse new ones. /health is what tells a restart from a network problem, so the
// tests also control its answer: failing, or naming another server process. The
// server itself is never restarted here; test/shutdown.test.ts in server/ does that.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { E2E_SERVER, E2E_SERVER_PORT } from "./env";
import { consoleLines, intoArena, overlay, player } from "./helpers";

const RESTARTED = "The match server restarted, so this match has ended. Create or join a match again.";
const LOST = "Lost the connection to the match server and could not get back in. Join again.";

/** The SDK only reconnects a room that has been up this long (SDK `minUptime`). */
const SDK_MIN_UPTIME_MS = 5000;

// As in hosted-leave.spec.ts: the routed WebSocket stand-in does not throw on the
// SDK's Node-style constructor call the way a browser does, so this wrapper does.
const SOCKET_SHIM = `
  window.__sockets = 0;
  const wrap = (Impl) => new Proxy(Impl, {
    construct(target, args) {
      const p = args[1];
      if (p !== undefined && typeof p !== "string" && !Array.isArray(p)) {
        throw new DOMException("protocols must be a string or an array", "SyntaxError");
      }
      window.__sockets++;
      return Reflect.construct(target, args);
    },
  });
  let current = wrap(window.WebSocket);
  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    get: () => current,
    set: (Impl) => { current = wrap(Impl); },
  });
`;

/** One player's connection to the match server, with faults on demand. */
async function faultyNetwork(context: BrowserContext) {
  const state = { down: false, health: "pass" as "pass" | "fail" | { instance: string } };
  type Live = { page: { close(o: { code: number; reason?: string }): Promise<void> }; upstream: WebSocket };
  const live = new Set<Live>();
  await context.addInitScript(SOCKET_SHIM);
  await context.routeWebSocket(new RegExp(`:${E2E_SERVER_PORT}/`), (ws) => {
    // the network is down: this attempt fails the way a browser reports it
    if (state.down) return void ws.close({ code: 1006 });
    const upstream = new WebSocket(ws.url());
    upstream.binaryType = "arraybuffer";
    const pending: (string | Buffer)[] = [];
    const link: Live = { page: ws, upstream };
    live.add(link);
    upstream.addEventListener("open", () => {
      for (const m of pending.splice(0)) upstream.send(m);
    });
    upstream.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
    upstream.addEventListener("close", (e) => {
      if (live.delete(link)) void ws.close({ code: e.code === 1005 ? 1006 : e.code });
    });
    ws.onMessage((m) => (upstream.readyState === WebSocket.OPEN ? upstream.send(m) : pending.push(m)));
    ws.onClose((code, reason) => {
      live.delete(link);
      if (upstream.readyState <= WebSocket.OPEN) upstream.close(code ?? 1000, reason);
    });
  });
  await context.route(/\/(health|matchmake)\b/, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/health") {
      if (state.health === "fail") return route.abort();
      if (state.health !== "pass") {
        return route.fulfill({
          json: { status: "ok", uptime: 1, instance: state.health.instance },
          headers: { "access-control-allow-origin": "*" },
        });
      }
      return route.fallback();
    }
    if (state.down) return route.abort();
    return route.fallback();
  });
  return {
    state,
    /** Every socket dies abnormally, with nothing delivered, and nothing new gets through. */
    cut() {
      state.down = true;
      for (const link of [...live]) {
        live.delete(link);
        void link.page.close({ code: 1006 });
        // the server sees a dropped player, not one who left
        if (link.upstream.readyState <= WebSocket.OPEN) link.upstream.close(3000, "network lost");
      }
    },
    restore() {
      state.down = false;
      state.health = "pass";
    },
  };
}

async function twoInArena(browser: import("@playwright/test").Browser) {
  const offHost: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await player(hostContext, "ADA", offHost);
  const guest = await player(guestContext, "GRACE", offHost);
  const hostNet = await faultyNetwork(hostContext);
  const guestNet = await faultyNetwork(guestContext);
  const code = await intoArena(host, guest);
  await guest.waitForTimeout(SDK_MIN_UPTIME_MS + 500);
  return { host, guest, hostNet, guestNet, code, close: () => Promise.all([hostContext.close(), guestContext.close()]) };
}

const sockets = (page: Page) => page.evaluate("window.__sockets") as Promise<number>;

async function expectTold(page: Page, text: string, timeout: number) {
  await expect(overlay(page).locator("h1")).toHaveText("CONNECTION LOST", { timeout });
  await expect(overlay(page).locator("h2")).toHaveText(text);
  await expect(overlay(page)).toHaveCount(1);
}

async function expectStillPlaying(page: Page) {
  await expect(page.locator(".dd-exit")).toBeVisible();
  await expect(page.locator(".dd-screen .panel h1", { hasText: "CONNECTION LOST" })).toHaveCount(0);
}

test("from the page, /health is readable and names the server process the room is on", async ({ browser }) => {
  const offHost: string[] = [];
  const context = await browser.newContext();
  const page = await player(context, "ADA", offHost);
  await page.goto("/online");
  const body = (await page.evaluate(`fetch(${JSON.stringify(`${E2E_SERVER}/health`)}, { cache: "no-store" }).then((r) => r.json())`)) as {
    status: string;
    instance: string;
  };
  expect(body.status).toBe("ok");
  expect(body.instance).toMatch(/^[0-9a-f]{16}$/);
  await context.close();
});

test("a short interruption: reconnected in the same seat, and nobody is told the server restarted", async ({ browser }) => {
  const { host, guest, guestNet, close } = await twoInArena(browser);
  const before = await sockets(guest);
  guestNet.state.health = "fail";
  guestNet.cut();

  await guest.waitForTimeout(6000);
  await expectStillPlaying(guest);
  expect(await sockets(guest), "the SDK kept trying").toBeGreaterThan(before);

  guestNet.restore();
  await expect.poll(() => consoleLines.filter((l) => l.includes("reconnected")).length, { message: "the guest is back", timeout: 15_000 }).toBeGreaterThan(0);
  await expect(host.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 2");
  await guest.waitForTimeout(3000);
  for (const page of [host, guest]) await expectStillPlaying(page);
  expect(consoleLines.filter((l) => l.includes("server restarted"))).toEqual([]);
  await close();
});

test("a long interruption: the seat expires and the guest is told that, not a restart, and can join again", async ({ browser }) => {
  test.setTimeout(180_000);
  const { host, guest, guestNet, code, close } = await twoInArena(browser);
  guestNet.state.health = "fail";
  guestNet.cut();
  // RECONNECT_SECONDS: past it the seat is gone
  await guest.waitForTimeout(33_000);
  await expectStillPlaying(guest);
  guestNet.restore();

  await expectTold(guest, LOST, 90_000);
  expect(consoleLines.filter((l) => l.includes("server restarted"))).toEqual([]);
  await expectStillPlaying(host);
  await expect(host.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 1", { timeout: 5000 });

  await overlay(guest).getByRole("button", { name: /LEAVE MATCH/ }).click();
  await guest.getByRole("button", { name: /JOIN A MATCH/ }).click();
  await guest.getByPlaceholder("ABCD").fill(code);
  await guest.getByRole("button", { name: /CONNECT/ }).click();
  await expect(host.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 2", { timeout: 20_000 });
  await close();
});

test("a restart with no notice and no close: both told at once, then LEAVE MATCH and a new room work", async ({ browser }) => {
  const { host, guest, hostNet, guestNet, close } = await twoInArena(browser);
  const replaced = { instance: "a-new-process" };
  hostNet.state.health = replaced;
  guestNet.state.health = replaced;
  const startedAt = Date.now();
  hostNet.cut();
  guestNet.cut();

  await expectTold(host, RESTARTED, 5000);
  await expectTold(guest, RESTARTED, 5000);
  expect(Date.now() - startedAt, "ms from the lost sockets to both players told").toBeLessThan(5000);

  // it stays up, it is the only message, and the retries have stopped
  await guest.waitForTimeout(1000);
  const settled = [await sockets(host), await sockets(guest)];
  await guest.waitForTimeout(6000);
  expect([await sockets(host), await sockets(guest)], "no more reconnection attempts").toEqual(settled);
  for (const page of [host, guest]) await expectTold(page, RESTARTED, 1000);

  // LEAVE MATCH returns to the menu
  hostNet.restore();
  guestNet.restore();
  for (const page of [host, guest]) {
    await overlay(page).getByRole("button", { name: /LEAVE MATCH/ }).click();
    await expect(page.locator(".dd-exit")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /JOIN A MATCH/ })).toBeVisible();
  }

  // a new room can be created and joined
  await host.getByRole("button", { name: /CREATE MATCH/ }).click();
  await expect(host.locator(".dd-netcode")).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  const code = (await host.locator(".dd-netcode").textContent())!.trim();
  await guest.getByRole("button", { name: /JOIN A MATCH/ }).click();
  await guest.getByPlaceholder("ABCD").fill(code);
  await guest.getByRole("button", { name: /CONNECT/ }).click();
  await expect(host.locator(".dd-roster")).toContainText("IN THE ROOM (2)", { timeout: 20_000 });
  await guest.getByRole("button", { name: /I'M READY/ }).click();
  await host.getByRole("button", { name: /ENTER ARENA/ }).click();
  for (const page of [host, guest]) await expect(page.locator(".dd-exit")).toBeVisible({ timeout: 30_000 });
  await close();
});

test("the server unavailable during the reconnect: no verdict until a new process actually answers", async ({ browser }) => {
  const { host, guest, hostNet, guestNet, close } = await twoInArena(browser);
  for (const net of [hostNet, guestNet]) {
    net.state.health = "fail";
    net.cut();
  }
  await guest.waitForTimeout(8000);
  for (const page of [host, guest]) await expectStillPlaying(page);

  const startedAt = Date.now();
  for (const net of [hostNet, guestNet]) net.state.health = { instance: "a-new-process" };
  await expectTold(host, RESTARTED, 6000);
  await expectTold(guest, RESTARTED, 6000);
  expect(Date.now() - startedAt).toBeLessThan(6000);
  await close();
});
