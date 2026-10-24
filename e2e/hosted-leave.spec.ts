// Leaving a match in a real browser, through a path that loses the server's
// WebSocket close (what the Render deployment does: see
// server/test/hosted-leave.test.ts for the traces and the Node version).
//
// Playwright's routeWebSocket puts the guest's room socket through a route
// whose server-side close handler swallows the server's close, so the page is
// never told; closes the page starts are still forwarded. Leaving must not
// depend on the server's close: the page closes with CONSENTED (4000) at once,
// opens no new socket, asks for no reconnection, and the host sees one player.
import { expect, test } from "./fixtures";
import { E2E_SERVER_PORT } from "./env";
import { intoArena, player } from "./helpers";

type SocketLog = { opened: number; closes: { code: number; clean: boolean; at: number }[]; leaveClickedAt: number };

// As a string, like the other specs' browser code: e2e/ is type-checked
// without the DOM library.
//
// Two jobs: record every socket and how it closed; and keep one browser
// behaviour that Playwright's routed WebSocket stand-in lacks. The SDK first
// tries `new WebSocket(url, { headers, protocols })` (Node's form); a real
// browser throws on that at once and the SDK falls back to the browser form,
// but the stand-in only fails later, so the SDK never falls back. The wrapper
// throws at once, as a browser does. It wraps whichever WebSocket the page ends
// up with (routeWebSocket installs its stand-in after this script runs).
const RECORD_SOCKETS = `
  window.__ws = { opened: 0, closes: [], leaveClickedAt: 0 };
  // when the page itself handles the LEAVE click (Playwright's click() first
  // waits for the button to be actionable, which is not the game's time)
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest(".dd-exit")) window.__ws.leaveClickedAt = performance.now();
  }, true);
  const wrap = (Impl) => new Proxy(Impl, {
    construct(target, args) {
      const p = args[1];
      if (p !== undefined && typeof p !== "string" && !Array.isArray(p)) {
        throw new DOMException("protocols must be a string or an array", "SyntaxError");
      }
      const ws = Reflect.construct(target, args);
      window.__ws.opened++;
      ws.addEventListener("close", (e) => window.__ws.closes.push({ code: e.code, clean: e.wasClean, at: performance.now() }));
      return ws;
    },
  });
  let current = wrap(window.WebSocket);
  Object.defineProperty(window, "WebSocket", {
    configurable: true,
    get: () => current,
    set: (Impl) => { current = wrap(Impl); },
  });
`;

test("leaving a match closes at once and never reconnects, even when the server's close is lost", async ({ browser }) => {
  const offHost: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await player(hostContext, "ADA", offHost);
  const guest = await player(guestContext, "GRACE", offHost);

  await guestContext.addInitScript(RECORD_SOCKETS);
  // The guest's room socket is bridged by this test process (Node's WebSocket),
  // not by Playwright's own forwarding, which passes the server's close on
  // regardless. Messages go both ways; a close from the page is passed to the
  // server and acknowledged; a close from the server is never passed on.
  let lostServerCloses = 0;
  await guestContext.routeWebSocket(new RegExp(`:${E2E_SERVER_PORT}/`), (ws) => {
    const upstream = new WebSocket(ws.url());
    upstream.binaryType = "arraybuffer";
    const pending: (string | Buffer)[] = [];
    upstream.addEventListener("open", () => {
      for (const m of pending.splice(0)) upstream.send(m);
    });
    upstream.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer)));
    // the hosting path's fault: the server's close never reaches the page
    upstream.addEventListener("close", () => void lostServerCloses++);
    ws.onMessage((m) => (upstream.readyState === WebSocket.OPEN ? upstream.send(m) : pending.push(m)));
    ws.onClose((code, reason) => {
      if (upstream.readyState <= WebSocket.OPEN) upstream.close(code ?? 1000, reason);
      ws.close({ code, reason });
    });
  });
  const reconnects: string[] = [];
  guest.on("request", (r) => {
    if (r.url().includes("/matchmake/reconnect")) reconnects.push(r.url());
  });
  const sockets = () => guest.evaluate("window.__ws") as Promise<SocketLog>;

  await intoArena(host, guest);
  await expect(host.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 2");
  const before = (await sockets()).opened;

  await guest.locator(".dd-exit").click();

  await expect
    .poll(async () => (await sockets()).closes.map((c) => c.code), { message: "the room socket closed", timeout: 2000 })
    .toContain(4000);
  // Through this bridge the server's close is never passed on, so a 4000 here
  // can only be the page's own close: the fix, not the server.
  const log = await sockets();
  const close = log.closes.find((c) => c.code === 4000)!;
  expect(close.clean).toBe(true);
  expect(log.leaveClickedAt).toBeGreaterThan(0);
  expect(close.at - log.leaveClickedAt, "ms from the LEAVE click to the closed socket").toBeLessThan(1000);

  // the host sees the guest gone (a held seat would still count)
  await expect(host.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 1", { timeout: 5000 });

  // and nothing comes back, well past when a lost close would have been noticed
  await guest.waitForTimeout(4000);
  expect((await sockets()).opened - before, "new sockets after leaving").toBe(0);
  expect(reconnects, "reconnection requests after leaving").toEqual([]);

  await hostContext.close();
  await guestContext.close();
});
