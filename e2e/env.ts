// Where the smoke tests' own servers listen (see playwright.config.ts). Both are
// local, started for the run and stopped after it.
export const E2E_SERVER_PORT = 2599;
export const E2E_WEB_PORT = 5199;
export const E2E_SERVER = `http://127.0.0.1:${E2E_SERVER_PORT}`;
export const E2E_WEB = `http://127.0.0.1:${E2E_WEB_PORT}`;
