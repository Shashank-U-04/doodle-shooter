# Doodle Shooter — multiplayer server

A [Colyseus](https://colyseus.io) 0.18 server for Doodle Shooter's online
matches. This is the first slice of the migration away from PeerJS (see
[`../docs/colyseus-migration.md`](../docs/colyseus-migration.md)): it owns the
lobby roster, the player limit, ready flags and match rules. The frontend does
not use it yet.

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

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Development server with reload |
| `npm run typecheck` | `tsc --noEmit` over `src` and `test` |
| `npm run lint` | ESLint |
| `npm test` | Mocha: unit tests plus two-client integration tests against a real server |
| `npm run build` | Compile to `build/` |
| `npm run serve` | Run the compiled server (`node build/index.js`) |
| `npm run check` | typecheck, lint, test and build, in that order |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | HTTP/WebSocket port |
| `NODE_ENV` | — | `production` hides `/monitor` and loads `.env.production` if present |

No secrets are required. `@colyseus/tools` reads an optional `.env` or
`.env.<NODE_ENV>` file; both are git-ignored.

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

**State** (`MatchState`): `code`, `phase` (`lobby`), `map`, `grapple`,
`maxPlayers`, `hostId`, `players` (map of `id`, `name`, `ink`, `isHost`,
`ready`).

**Messages**

| Type | Payload | Who | Rule |
|---|---|---|---|
| `ready` | `{ ready: boolean }` | guests | lobby only; the host is always ready |
| `config` | `{ map?, grapple? }` | host | lobby only; unknown maps rejected |

A payload that fails validation disconnects its sender.

**Leaving:** a guest who leaves is removed. If the host leaves, the
longest-standing guest becomes host. An empty room is disposed and its code
freed.

## Limits

Room-code uniqueness is tracked in process memory, so run a single process. To
scale out you would need Colyseus' Redis presence and driver.
