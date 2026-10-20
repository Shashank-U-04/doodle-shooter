import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { turnPreflight, turnRequest } from "./turn";

const http = httpRouter();

auth.addHttpRoutes(http);

// Short-lived TURN relay credentials for online play. The relay's shared
// secret lives in this deployment's env (TURN_URLS / TURN_SECRET), never in the
// client bundle — see src/convex/turn.ts and README › Playing across networks.
http.route({ path: "/turn", method: "GET", handler: turnRequest });
http.route({ path: "/turn", method: "OPTIONS", handler: turnPreflight });

export default http;
