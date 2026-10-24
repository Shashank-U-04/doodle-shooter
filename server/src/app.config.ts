import { defineServer, defineRoom, matchMaker, monitor, WebSocketTransport } from "colyseus";
import { MatchRoom } from "./rooms/MatchRoom.js";
import { isOriginAllowed, normalizeOrigin, originPolicy } from "./origins.js";
import { roomLimitsFromEnv } from "./limits.js";
import { metrics } from "./metrics.js";
import { roomStats } from "./rooms/MatchRoom.js";
import { e2eFixturesEnabled, mountE2eFixtures } from "./e2e.js";

const startedAt = Date.now();

if (originPolicy.rejected.length > 0) {
  console.warn(`[origins] ignoring invalid ALLOWED_ORIGINS entries: ${originPolicy.rejected.join(", ")}`);
}
if (originPolicy.allowed.size === 0) {
  console.warn("[origins] ALLOWED_ORIGINS is empty: no browser origin can use this server");
}
if (roomLimitsFromEnv.rejected.length > 0) {
  console.warn(`[limits] ignoring invalid values (positive integers only): ${roomLimitsFromEnv.rejected.join(", ")}`);
}

// A room's code is its only lock, so the only ways in are a new room of your
// own (`create`), a code you were given (`joinById`) and your own seat back
// (`reconnect`). Colyseus also exposes `join` and `joinOrCreate` by default,
// which seat the caller in any open room: a stranger could join a match
// without its code. (Rooms are private as well; see MatchRoom.onCreate.)
matchMaker.controller.exposedMethods = ["create", "joinById", "reconnect"];

// One JSON line per window while anything happened (src/metrics.ts).
// METRICS_INTERVAL_S: window length in seconds (default 60; 0 turns it off).
const metricsIntervalS = Number(process.env.METRICS_INTERVAL_S ?? 60);
if (Number.isFinite(metricsIntervalS) && metricsIntervalS > 0) {
  setInterval(() => {
    const { rooms, players } = roomStats();
    const line = metrics.flush(rooms, players, process.memoryUsage());
    if (line) console.log(JSON.stringify(line));
  }, metricsIntervalS * 1000).unref();
}

// CORS: Colyseus answers every origin with `*` (and allows credentials) by
// default. Name the caller's origin, and allow credentials, only when it is on
// the allow-list; otherwise send neither and let the browser refuse the
// response. This only governs browsers; the matchmaker and the WebSocket
// upgrade enforce the same list themselves.
const defaultCors = matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>;
delete defaultCors["Access-Control-Allow-Origin"];
delete defaultCors["Access-Control-Allow-Credentials"];
matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
  const origin = normalizeOrigin(headers.get("origin"));
  if (!origin || !isOriginAllowed(origin, originPolicy)) return { Vary: "Origin" };
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
};

const server = defineServer({
  rooms: {
    match: defineRoom(MatchRoom),
  },

  transport: new WebSocketTransport({
    // Reconnections skip matchmaking auth, so the socket itself is checked.
    beforeUpgrade: (_request, context) => {
      if (!isOriginAllowed(context.headers.get("origin"), originPolicy)) {
        return new Response(null, { status: 403 });
      }
    },
  }),

  express: (app) => {
    /** Liveness probe for the host platform. Reveals nothing about rooms or players. */
    app.get("/health", (_req, res) => {
      res.json({ status: "ok", uptime: Math.round((Date.now() - startedAt) / 1000) });
    });

    // The room monitor shows every room's state; it stays out of production
    // until it can be put behind a password.
    if (process.env.NODE_ENV !== "production") {
      app.use("/monitor", monitor());
    }

    // Browser smoke-test fixtures (src/e2e.ts); never in production.
    if (e2eFixturesEnabled(process.env)) {
      console.warn("[e2e] E2E_FIXTURES=1: test fixtures are mounted; never set this on a deployed server");
      mountE2eFixtures(app);
    }
  },
});

export default server;
