// Shared by the browser smoke tests: each player in their own browser context,
// with no way off this machine, and the steps every test repeats.
import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { E2E_SERVER } from "./env";

export const HOST = "ADA";
export const GUEST = "GRACE";

/** A player's own browser: their name remembered, and no way off this machine. */
export async function player(context: BrowserContext, name: string, offHost: string[]): Promise<Page> {
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

/** The arena's full-screen panels (winner, connection lost, down, paused). */
export const overlay = (page: Page) => page.locator(".dd-screen .panel").filter({ has: page.locator("h1") });

/** Ask the test server to finish the match for `winner`, once both bodies are placed. */
export async function finishMatch(request: APIRequestContext, code: string, winner: string) {
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
export async function openRoom(host: Page): Promise<string> {
  await host.goto("/online?create=1&map=district&grapple=1");
  await expect(host.locator(".dd-netcode")).toHaveText(/^[A-Z0-9]{4}$/, { timeout: 20_000 });
  return (await host.locator(".dd-netcode").textContent())!.trim();
}

/** HOST opens a room, GUEST joins it with ?room=, readies, and both enter the arena. */
export async function intoArena(host: Page, guest: Page): Promise<string> {
  const code = await openRoom(host);
  await guest.goto(`/online?room=${code}`);
  await expect(host.locator(".dd-roster")).toContainText("IN THE ROOM (2)", { timeout: 20_000 });
  await guest.getByRole("button", { name: /I'M READY/ }).click();
  await host.getByRole("button", { name: /ENTER ARENA/ }).click();
  for (const page of [host, guest]) await expect(page.locator(".dd-exit")).toBeVisible({ timeout: 30_000 });
  return code;
}
