// The game starts on its own: no Convex deployment, no Freebuff/VLY editor
// bridge, no third-party scripts. The build under test (playwright.config.ts)
// has no Convex or VLY variables at all, so a page that still needed them would
// crash here.
//
// Every page is checked for:
// - requests leaving this machine: only the Google Fonts stylesheet and font
//   files may be attempted (all off-host requests are aborted either way);
// - messages to the parent frame: the editor bridge posted route changes and
//   errors there. In a top-level page `window.parent === window`, so anything
//   posted to the parent arrives as a `message` event on the page itself;
// - uncaught page errors.
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { consoleLines } from "./helpers";

const ALLOWED_OFF_HOST = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
const MAPS = ["district", "valley", "sanctuary", "tomb"] as const;

type Watch = { page: Page; offHost: string[]; errors: string[] };

async function watch(context: BrowserContext): Promise<Watch> {
  const offHost: string[] = [];
  const errors: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    offHost.push(url.href);
    return route.abort();
  });
  // As a string, like the other specs' init scripts: this file is type-checked
  // without the DOM library (tsconfig.node.json).
  await context.addInitScript(`
    localStorage.setItem("dd_name", "ADA"); // a remembered name, so an invite link joins straight away
    window.__messages = [];
    window.addEventListener("message", (e) => {
      const d = e.data;
      window.__messages.push(d && typeof d === "object" ? String(d.type ?? "(object)") : String(d));
    });
  `);
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    errors.push(err.message);
    consoleLines.push(`${new Date().toISOString()} pageerror ${err.message}`);
  });
  page.on("console", (msg) => consoleLines.push(`${new Date().toISOString()} ${msg.type()} ${msg.text()}`));
  return { page, offHost, errors };
}

async function expectClean({ page, offHost, errors }: Watch) {
  const foreign = offHost.filter((u) => !ALLOWED_OFF_HOST.has(new URL(u).hostname));
  expect(foreign, "requests to third-party hosts").toEqual([]);
  expect(offHost.filter((u) => /convex|jsdelivr|vly|freebuff|peerjs/i.test(u))).toEqual([]);
  expect(await page.evaluate("window.__messages"), "messages posted to the parent frame").toEqual([]);
  expect(errors, "uncaught page errors").toEqual([]);
}

test("the menus and the online lobby start without Convex or the editor bridge", async ({ browser }) => {
  const context = await browser.newContext();
  const w = await watch(context);

  await w.page.goto("/");
  await expect(w.page.getByRole("heading", { name: "DOODLE SHOOTER" })).toBeVisible();

  await w.page.goto("/setup?mode=friends");
  await expect(w.page.locator("body")).toContainText("CREATE ROOM");

  await w.page.goto("/online");
  await expect(w.page.getByRole("heading", { name: "PLAY WITH FRIENDS" })).toBeVisible();

  // An old invite link: Convex Auth used to swallow `?code=` as a sign-in code.
  // Now the lobby gets it, asks the match server, and says the room is unknown.
  await w.page.goto("/online?code=ZZZZ");
  await expect(w.page.locator("body")).toContainText("No match with code ZZZZ", { timeout: 20_000 });

  // The routes that belonged to the removed sign-in flow are gone, not broken.
  for (const gone of ["/auth", "/dashboard"]) {
    await w.page.goto(gone);
    await expect(w.page.locator("body")).not.toContainText("Runtime error");
  }

  await expectClean(w);
  await context.close();
});

for (const map of MAPS) {
  test(`the ${map} map loads`, async ({ browser }) => {
    const context = await browser.newContext();
    const w = await watch(context);
    await w.page.goto(`/game?map=${map}&grapple=1`);
    // the engine mounts its canvas, builds the map and reports the area it put us in
    await expect(w.page.locator(".dd-stage canvas")).toHaveCount(1, { timeout: 60_000 });
    await expect(w.page.locator(".dd-area")).not.toBeEmpty({ timeout: 60_000 });
    await expectClean(w);
    await context.close();
  });
}
