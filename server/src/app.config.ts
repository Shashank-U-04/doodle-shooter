import { defineServer, defineRoom, matchMaker, monitor, WebSocketTransport } from "colyseus";
import { MatchRoom } from "./rooms/MatchRoom.js";
import { isOriginAllowed, normalizeOrigin, originPolicy } from "./origins.js";

const startedAt = Date.now();

if (originPolicy.rejected.length > 0) {
  console.warn(`[origins] ignoring invalid ALLOWED_ORIGINS entries: ${originPolicy.rejected.join(", ")}`);
}
if (originPolicy.allowed.size === 0) {
  console.warn("[origins] ALLOWED_ORIGINS is empty: no browser origin can use this server");
}

// CORS: Colyseus answers every origin with `*` by default. Name the caller's
// origin only when it is on the allow-list; otherwise send no allow-origin
// header and let the browser refuse the response. This only governs browsers;
// the matchmaker and the WebSocket upgrade enforce the same list themselves.
delete (matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>)["Access-Control-Allow-Origin"];
matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
  const origin = normalizeOrigin(headers.get("origin"));
  if (!origin || !isOriginAllowed(origin, originPolicy)) return { Vary: "Origin" };
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
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
  },
});

export default server;
