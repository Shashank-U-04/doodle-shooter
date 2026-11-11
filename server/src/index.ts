/**
 * IMPORTANT:
 * ---------
 * Do not manually edit this file if you'd like to host your server on Colyseus Cloud
 *
 * If you're self-hosting, you can see "Raw usage" from the documentation.
 *
 * See: https://docs.colyseus.io/server
 */
import { listen } from "@colyseus/tools";

// Import Colyseus config
import app from "./app.config.js";
import { installProcessLifecycle, logLifecycle } from "./lifecycle.js";

installProcessLifecycle();

// Create and listen on 2567 (or PORT environment variable.)
const server = await listen(app);

// Colyseus' own shutdown steps, around closing the rooms (see src/lifecycle.ts).
server.onBeforeShutdown(() => logLifecycle("shutdown-started"));
server.onShutdown(() => logLifecycle("shutdown-finished"));
