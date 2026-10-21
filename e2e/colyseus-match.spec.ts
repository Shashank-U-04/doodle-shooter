// Smoke test of an online match over the Colyseus transport, in a real browser
// against the real frontend build and the real match server (see
// playwright.config.ts): two players in separate browser contexts create and
// join a room, enter the arena, finish a match, and run a rematch after the
// original host has left.
//
// One step is a fixture: a browser cannot aim, so the server's test-only route
// (server/src/e2e.ts) puts the host on 14 kills and lands the 15th through the
// room's own damage code. Everything after that — the server declaring the
// winner, the state patch, the overlay, host migration and the rematch — is the
// real thing.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { E2E_SERVER } from "./env";

const HOST = "ADA";
const GUEST = "GRACE";

/** A player's own browser: their name remembered, and no way off this machine. */
async function player(context: BrowserContext, name: string, offHost: string[]): Promise<Page> {
  await context.addInitScript(`localStorage.setItem("dd_name", ${JSON.stringify(name)})`);
  await context.route("**/*", (route) => {
    const { hostname } = new URL(route.request().url());
    if (hostname === "127.0.0.1" || hostname === "localhost") return route.continue();
    offHost.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.warn(`[${name} pageerror] ${err.message}`));
  return page;
}

/** The match overlay (winner panel); the arena's other screens use the same class. */
const overlay = (page: Page) => page.locator(".dd-screen .panel").filter({ has: page.locator("h1") });

/** Ask the test server to finish the match for `winner`, once both bodies are placed. */
async function finishMatch(request: APIRequestContext, code: string, winner: string) {
  await expect
    .poll(
      async () => {
        const res = await request.post(`${E2E_SERVER}/__e2e/rooms/${code}/win`, { data: { winner } });
        return res.status();
      },
      { message: "both players placed in the arena", timeout: 20_000, intervals: [250] },
    )
    .toBe(200);
}

/** Open a room as HOST and return its code. */
async function openRoom(host: Page): Promise<string> {
  await host.goto("/online?create=1&map=district&grapple=1");
  await expect(host.locator(".dd-netcode")).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  return (await host.locator(".dd-netcode").textContent())!.trim();
}

test("an old ?code= link still joins, and a guest's reload takes back the same seat", async ({ browser }) => {
  const offHost: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await player(hostContext, HOST, offHost);
  const guest = await player(guestContext, GUEST, offHost);
  const code = await openRoom(host);

  await guest.goto(`/online?code=${code}`);
  for (const page of [host, guest]) {
    await expect(page.locator(".dd-roster")).toContainText("IN THE ROOM (2)", { timeout: 20_000 });
  }
  await guest.getByRole("button", { name: /I'M READY/ }).click();
  await expect(host.locator(".dd-roster")).toContainText(`${GUEST} · ready`);

  await guest.reload();
  await expect(guest.locator(".dd-roster")).toContainText(`${GUEST} (you) · ready`, { timeout: 20_000 });
  // the same seat, not a second one; and the host never saw two GRACEs
  for (const page of [host, guest]) await expect(page.locator(".dd-roster")).toContainText("IN THE ROOM (2)");
  await expect(host.locator(".dd-roster .row", { hasText: GUEST })).toHaveCount(1);

  await hostContext.close();
  await guestContext.close();
});

test("lobby → arena → winner → host leaves → promoted host rematches", async ({ browser, request }) => {
  const offHost: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await player(hostContext, HOST, offHost);
  const guest = await player(guestContext, GUEST, offHost);

  const code = await test.step("host opens a room and gets a code", () => openRoom(host));

  await test.step("guest joins by code; both rosters show two players", async () => {
    await guest.goto(`/online?room=${code}&map=district&grapple=1`);
    // read once, then off the URL (and never in `code`, which Convex Auth takes)
    await expect(guest).toHaveURL(/\/online\?map=district&grapple=1$/);
    for (const page of [host, guest]) {
      await expect(page.locator(".dd-roster")).toContainText("IN THE ROOM (2)", { timeout: 20_000 });
    }
    await expect(guest.locator(".dd-roster")).toContainText(`${HOST} · host`);
    await expect(host.getByRole("button", { name: /ENTER ARENA/ })).toBeDisabled();
  });

  await test.step("guest readies, host enters the arena, both arrive", async () => {
    await guest.getByRole("button", { name: /I'M READY/ }).click();
    const enter = host.getByRole("button", { name: /ENTER ARENA/ });
    await expect(enter).toBeEnabled();
    await enter.click();
    for (const page of [host, guest]) {
      await expect(page.locator(".dd-exit")).toHaveText(`← LEAVE MATCH (room ${code})`, { timeout: 30_000 });
      await expect(page.locator(".dd-stage canvas")).toBeVisible();
      await expect(page.locator(".dd-hud-tl .score")).toHaveText("KILLS 0 / 15");
      await expect(page.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 2");
    }
  });

  await test.step("the server ends the match; each side sees its result", async () => {
    await finishMatch(request, code, HOST);
    await expect(overlay(host).locator("h1")).toHaveText("YOU WIN");
    await expect(overlay(host).locator("h2")).toHaveText(`${HOST} took it · 15 kills`);
    await expect(host.getByRole("button", { name: /REMATCH/ })).toBeVisible();
    await expect(overlay(guest).locator("h1")).toHaveText("MATCH OVER");
    await expect(overlay(guest).locator("h2")).toHaveText(`${HOST} took it · 15 kills`);
    await expect(guest.getByText("waiting for the host to start a rematch…")).toBeVisible();
    await expect(guest.getByRole("button", { name: /REMATCH/ })).toHaveCount(0);
  });

  await test.step("the result holds steady while the arena keeps re-rendering", async () => {
    // The HUD re-renders many times a second; the result must not flicker,
    // restart the round or fall back to the pause screen.
    for (let i = 0; i < 6; i++) {
      await host.waitForTimeout(250);
      await expect(overlay(host).locator("h1")).toHaveText("YOU WIN");
      await expect(overlay(guest).locator("h1")).toHaveText("MATCH OVER");
      await expect(host.locator(".dd-hud-tl .score")).toHaveText("KILLS 15 / 15");
    }
    for (const page of [host, guest]) await expect(page.getByText("PAUSED", { exact: true })).toHaveCount(0);
  });

  await test.step("the original host leaves; the guest is promoted and can rematch", async () => {
    await overlay(host).getByRole("button", { name: "LEAVE MATCH" }).click();
    await expect(host.locator(".dd-exit")).toHaveCount(0);
    // the winner has gone, but the match stays decided until a rematch
    await expect(overlay(guest).locator("h2")).toHaveText("A PLAYER WHO LEFT took it · 15 kills", { timeout: 15_000 });
    await expect(guest.locator(".dd-hud-tr .wave")).toHaveText("FREE FOR ALL 1");
    await expect(guest.getByRole("button", { name: /REMATCH/ })).toBeVisible();
    await expect(guest.getByText("waiting for the host to start a rematch…")).toHaveCount(0);
  });

  await test.step("the promoted host's rematch clears the result for good", async () => {
    await guest.getByRole("button", { name: /REMATCH/ }).click();
    await expect(overlay(guest)).toHaveCount(0, { timeout: 15_000 });
    await expect(guest.locator(".dd-hud-tl .score")).toHaveText("KILLS 0 / 15");
    await expect(guest.locator(".dd-exit")).toHaveText(`← LEAVE MATCH (room ${code})`);
    await guest.waitForTimeout(1500);
    await expect(overlay(guest)).toHaveCount(0);
  });

  // Nothing tried to leave this machine except what the route blocked (logged
  // for review; the app must still work with all of it blocked).
  if (offHost.length) console.log(`blocked off-host requests:\n  ${[...new Set(offHost)].join("\n  ")}`);
  await hostContext.close();
  await guestContext.close();
});
