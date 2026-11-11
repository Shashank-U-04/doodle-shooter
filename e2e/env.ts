import { fileURLToPath } from "node:url";

// Where the smoke tests' own servers listen (see playwright.config.ts). Both are
// local, started for the run and stopped after it.
export const E2E_SERVER_PORT = 2599;
export const E2E_WEB_PORT = 5199;
export const E2E_SERVER = `http://127.0.0.1:${E2E_SERVER_PORT}`;
export const E2E_WEB = `http://127.0.0.1:${E2E_WEB_PORT}`;

// One id per `playwright test` run, set where the config is first loaded and
// inherited by the test workers, so a run's artifacts never overwrite an
// earlier run's (an intermittent failure stays readable after later runs).
process.env.E2E_RUN_ID ??= new Date().toISOString().replace(/[:.]/g, "-");
export const E2E_RUN_ID = process.env.E2E_RUN_ID;
/** this run's screenshots, traces and attachments */
export const E2E_RESULTS = `e2e/.results/${E2E_RUN_ID}`;
/** this run's match-server output (beside, not inside, E2E_RESULTS, which Playwright empties at start) */
export const E2E_SERVER_LOG = fileURLToPath(new URL(`./.results/${E2E_RUN_ID}-server.log`, import.meta.url));
