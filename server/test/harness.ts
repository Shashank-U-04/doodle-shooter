// One server for the whole test run. app.config.ts is a module singleton (its
// transport and CORS hooks are installed once), so booting it twice in one
// process breaks the second boot. `mocha --exit` ends the process afterwards.
import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";

let booting: Promise<ColyseusTestServer<typeof appConfig>> | null = null;

export function testServer() {
  booting ??= boot(appConfig);
  return booting;
}
