// Browser smoke tests (e2e/). Everything runs locally and in isolation:
//
// - a Colyseus match server from server/src on E2E_SERVER_PORT, with the
//   test-only fixtures (server/src/e2e.ts) and only the test frontend's origin
//   allowed;
// - a production build of the frontend (the same path a Vercel Preview takes:
//   `vite build` with VITE_NET_TRANSPORT / VITE_COLYSEUS_URL baked in), served
//   by `vite preview` on E2E_WEB_PORT from its own output folder;
// - VITE_CONVEX_URL points at a closed local port, so the app boots without
//   reaching any Convex deployment. The spec also aborts every request that
//   leaves 127.0.0.1.
//
// Setup: `bun install`, `npm ci` in server/, then `bunx playwright install chromium`.
// Run: `bun run test:e2e`.
import { defineConfig, devices } from "@playwright/test";
import { E2E_RESULTS, E2E_SERVER, E2E_SERVER_LOG, E2E_SERVER_PORT, E2E_WEB as WEB, E2E_WEB_PORT } from "./e2e/env";

export default defineConfig({
  testDir: "e2e",
  // a folder per run (E2E_RUN_ID): earlier runs' failures are kept, not overwritten
  outputDir: E2E_RESULTS,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // WebGL without a GPU (headless, CI): the arena is a Three.js canvas.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
  ],
  webServer: [
    {
      // the server, with its output also kept in E2E_SERVER_LOG (see e2e/fixtures.ts)
      command: "node ../e2e/server-with-log.mjs",
      cwd: "server",
      url: `${E2E_SERVER}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(E2E_SERVER_PORT),
        NODE_ENV: "test",
        E2E_FIXTURES: "1",
        ALLOWED_ORIGINS: WEB,
        // seats, drops and leaves with close codes, rate-limit kicks: no payloads, tokens or names
        DEBUG: "colyseus:matchmaking,colyseus:errors",
        DEBUG_COLORS: "0",
        E2E_SERVER_LOG,
      },
    },
    {
      command: `npx vite build --outDir e2e/.dist --emptyOutDir && npx vite preview --outDir e2e/.dist --host 127.0.0.1 --port ${E2E_WEB_PORT} --strictPort`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        VITE_NET_TRANSPORT: "colyseus",
        VITE_COLYSEUS_URL: E2E_SERVER,
        VITE_CONVEX_URL: "http://127.0.0.1:9",
      },
    },
  ],
});
