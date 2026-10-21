// The browser tests' `test`: Playwright's own, plus connection diagnostics kept
// with every failure, so an intermittent one can be read after the fact.
//
// On a failed test, two attachments join the screenshot and trace:
// - browser-console.txt: every console line from every player's page, time-
//   stamped, including the Colyseus client's connection log (close codes,
//   reconnect attempts; see logConnection in src/game/colyseus.ts);
// - server.log: what the match server printed during this test (Colyseus
//   matchmaking debug: seats, drops and leaves with close codes, and any client
//   it dropped for flooding), from the run's server log (e2e/server-with-log.mjs).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { test as base } from "@playwright/test";
import { consoleLines } from "./helpers";
import { E2E_SERVER_LOG } from "./env";

const size = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

export const test = base.extend<{ connectionDiagnostics: void }>({
  connectionDiagnostics: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      consoleLines.length = 0;
      const from = size(E2E_SERVER_LOG);
      await use();
      if (testInfo.status === testInfo.expectedStatus) return;
      let server = "(no server log)";
      try {
        server = readFileSync(E2E_SERVER_LOG).subarray(from).toString("utf8") || "(the server printed nothing during this test)";
      } catch {
        // keep the placeholder
      }
      // written as files beside the screenshot and trace, not only into the report
      for (const [name, text] of [
        ["browser-console.txt", consoleLines.join("\n") || "(no console output)"],
        ["server.log", server],
      ] as const) {
        const path = testInfo.outputPath(name);
        writeFileSync(path, text);
        await testInfo.attach(name, { path, contentType: "text/plain" });
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
