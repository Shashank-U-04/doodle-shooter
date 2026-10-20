# Doodle Shooter — multiplayer server

A [Colyseus](https://colyseus.io) 0.18 server for Doodle Shooter's online
matches, part of the migration away from PeerJS (see
[`../docs/colyseus-migration.md`](../docs/colyseus-migration.md)). It owns the
lobby: roster, player limit, ready flags, match rules, the decision to start,
and reconnection. The frontend uses it only when built with
`VITE_NET_TRANSPORT=colyseus`; PeerJS is still the default. Gameplay traffic
does not run through it yet.

It is a standalone npm package with its own `package-lock.json`. The root
frontend build, lint and Vercel deployment do not touch this folder.

## Requirements

- Node.js 22 or newer
- npm

## Setup

```sh
cd server
npm ci
npm start          # tsx watch on http://localhost:2567
```

- `GET /health` returns `{"status":"ok","uptime":<seconds>}`.
- `/monitor` shows the Colyseus room monitor in development only. It is not
  mounted when `NODE_ENV=production`.

To try it with the game, run the frontend with the flag (from the repo root):
`VITE_NET_TRANSPORT=colyseus bun run dev`, then open `/online` in two browsers.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Development server with reload |
| `npm run typecheck` | `tsc --noEmit` over `src` and `test` |
| `npm run lint` | ESLint |
| `npm test` | Mocha: unit tests, multi-client integration tests against a real server, and the frontend's lobby adapter (`src/game/colyseus.ts`) driven against it |
| `npm run build` | Compile to `build/` |
| `npm run serve` | Run the compiled server (`node build/index.js`) |
| `npm run check` | typecheck, lint, test and build, in that order |

`test/frontend-adapter.test.ts` imports the frontend's adapter and is excluded
from this package's `tsc` (it would type-check the frontend with server
settings); the root `tsc -b` type-checks the adapter itself.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | HTTP/WebSocket port |
| `NODE_ENV` | — | `production` hides `/monitor`, drops the development origins, and loads `.env.production` if present |
| `ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to use the server, exact `scheme://host[:port]` (e.g. `https://your-app.vercel.app`). No wildcards; invalid entries are logged and ignored |

No secrets are required. `@colyseus/tools` reads an optional `.env` or
`.env.<NODE_ENV>` file; both are git-ignored.

## Origins

Outside production, the Vite origins `http://localhost:5173`,
`http://127.0.0.1:5173`, `http://localhost:4173` and `http://127.0.0.1:4173`
are always allowed. In production, **only** `ALLOWED_ORIGINS` is: with it unset,
no browser can use the server (it logs a warning at startup). Vercel preview
deployments get their own URLs, so each one you want to test must be listed.

The list is enforced in three places: CORS headers name only an allowed origin,
matchmaking (`onAuth`) refuses other origins, and the WebSocket upgrade answers
them with 403 — the last one also covers reconnections, which skip matchmaking.

An Origin header is what a *browser* reports. It keeps other websites from
using the server through their visitors' browsers; it does not authenticate
anyone, because any other client can send any Origin, or none. Requests with no
Origin are allowed for that reason.

## The `match` room

Create a room and join one by code with `@colyseus/sdk`:

```ts
import { Client } from "@colyseus/sdk";
const client = new Client("http://localhost:2567");
const host = await client.create("match", { name: "Ada", map: "valley", grapple: true, maxPlayers: 4 });
host.roomId; // the 4-letter room code, e.g. "K7QM"
const guest = await client.joinById(host.roomId, { name: "Grace" });
```

**Create options** (all optional; anything malformed falls back to the default):
`name` (≤ 16 chars, default `HOST`), `map` (`district` | `valley` | `sanctuary`
| `tomb`, default `district`), `grapple` (default `true`), `maxPlayers` (2–4,
default 4).

**State** (`MatchState`): `code`, `phase` (`lobby` → `playing`), `map`,
`grapple`, `maxPlayers`, `hostId`, `players` (map of `id`, `name`, `ink`,
`isHost`, `ready`, `connected`).

**Messages**

| Type | Payload | Who | Rule |
|---|---|---|---|
| `ready` | `{ ready: boolean }` | guests | lobby only; the host is always ready |
| `config` | `{ map?, grapple? }` | host | lobby only; unknown maps rejected |
| `start` | — | host | send with `room.request("start")`; answers `{ ok: true }` or `{ ok: false, reason }` |

`start` is refused with `not-host`, `not-in-lobby`, `no-guests` (nobody to play),
`guest-reconnecting` (a guest's seat is held for a reconnection) or
`guests-not-ready`. On success `phase` becomes `playing`; lobby messages are
ignored from then on. Players can still join a running match, as with PeerJS.

A payload that fails validation disconnects its sender.

## Leaving and reconnecting

- **Leaving on purpose** (`room.leave()`) frees the seat at once.
- **Dropping** (reload, closed tab, lost network) holds the seat for
  `RECONNECT_SECONDS` (30, in `src/rules.ts`); the roster shows it with
  `connected: false`. Only `client.reconnect(room.reconnectionToken)` can take it
  back — the token is issued to that client alone — and it comes back with the
  same session id, ready flag and ink. A fresh join always gets a fresh seat.
- If the token's owner reconnects while the old socket still looks alive,
  Colyseus closes the stale socket and hands over the seat, so a fast reload
  never produces a duplicate.
- When the hold expires the player is removed. A host keeps the host role while
  their seat is held; once it is released, the longest-standing connected guest
  becomes host.
- An empty room is disposed and its code freed.

## Limits

Room-code uniqueness is tracked in process memory, so run a single process. To
scale out you would need Colyseus' Redis presence and driver.
