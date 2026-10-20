import { defineServer, defineRoom, monitor } from "colyseus";
import { MatchRoom } from "./rooms/MatchRoom.js";

const startedAt = Date.now();

const server = defineServer({
  rooms: {
    match: defineRoom(MatchRoom),
  },

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
