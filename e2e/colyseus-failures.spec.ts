// What players see when the match server is slow or goes away: the two ways a
// free-tier host misbehaves (a cold start after spinning down, a restart on
// redeploy). Both must be explained on screen, not left as a silent hang or a
// dead arena.
import { expect, test } from "./fixtures";
import { E2E_SERVER } from "./env";
import { GUEST, HOST, intoArena, overlay, player } from "./helpers";

test("a slow (waking) match server is explained, and the room still opens", async ({ browser }) => {
  const offHost: string[] = [];
  const context = await browser.newContext();
  const host = await player(context, HOST, offHost);
  // matchmaking answers only after 8 s, as a spun-down host does after its wake-up
  await host.route(/\/matchmake\//, async (route) => {
    await new Promise((r) => setTimeout(r, 8000));
    await route.continue();
  });
  await host.goto("/online?create=1&map=district&grapple=1");
  await expect(host.locator(".dd-netstatus").first()).toHaveText("OPENING YOUR ROOM…");
  await expect(host.getByText(/WAKING THE MATCH SERVER/)).toBeVisible({ timeout: 7000 });
  await expect(host.locator(".dd-netcode")).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  await expect(host.getByText(/WAKING THE MATCH SERVER/)).toHaveCount(0);
  await context.close();
});

test("a server restart mid-match stops both arenas and says why", async ({ browser, request }) => {
  const offHost: string[] = [];
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await player(hostContext, HOST, offHost);
  const guest = await player(guestContext, GUEST, offHost);
  const code = await intoArena(host, guest);

  // what SIGTERM does to every room on the server
  expect((await request.post(`${E2E_SERVER}/__e2e/rooms/${code}/shutdown`)).status()).toBe(200);
  for (const page of [host, guest]) {
    await expect(overlay(page).locator("h1")).toHaveText("CONNECTION LOST");
    await expect(overlay(page).locator("h2")).toContainText("The match server restarted, so this match has ended.");
  }
  // it stays up (the kill feed's version of it used to vanish after 4 s)
  await host.waitForTimeout(5000);
  await expect(overlay(host).locator("h1")).toHaveText("CONNECTION LOST");

  await overlay(guest).getByRole("button", { name: /LEAVE MATCH/ }).click();
  await expect(guest.locator(".dd-exit")).toHaveCount(0);
  await expect(guest.getByRole("button", { name: /JOIN/ }).first()).toBeVisible();
  await hostContext.close();
  await guestContext.close();
});
