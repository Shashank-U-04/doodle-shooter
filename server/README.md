# Doodle Shooter — multiplayer server

A [Colyseus](https://colyseus.io) 0.18 server for Doodle Shooter's online
matches, part of the migration away from PeerJS (see
[`../docs/colyseus-migration.md`](../docs/colyseus-migration.md)). It owns the
lobby: roster, player limit, ready flags, match rules, the decision to start,
and reconnection — and, in the arena, every player's body (position, facing,
movement state) within server-enforced limits, and all combat: clients send
intent, the server decides hits, damage, health, deaths, respawns, scores and
the winner. The frontend uses it only when built with
`VITE_NET_TRANSPORT=colyseus`; PeerJS is still the default.

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

`test/shutdown.test.ts` starts the real server in a child process and stops it
with SIGTERM. Windows cannot deliver a catchable SIGTERM to a child, so there
the test raises the same signal event inside the process over IPC
(`test/fixtures/shutdown-child.ts`); on Linux and macOS it sends a real one.

`test/frontend-adapter.test.ts` (the frontend's lobby adapter) and
`test/geometry.test.ts` (the real map builders) import frontend code, so the
root dependencies must be installed too (`bun install` in the repo root). They
are excluded from this package's `tsc`, which would type-check the frontend with
server settings; the root `tsc -b` type-checks that code.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `2567` | HTTP/WebSocket port |
| `NODE_ENV` | — | `production` hides `/monitor`, drops the development origins, and loads `.env.production` if present |
| `ALLOWED_ORIGINS` | — | Comma-separated browser origins allowed to use the server, exact `scheme://host[:port]` (e.g. `https://your-app.vercel.app`). No wildcards; invalid entries are logged and ignored |
| `MAX_ROOMS` | `100` | Live rooms this process holds; a create beyond it is refused (HTTP 429) |
| `ROOM_CREATES_PER_MINUTE` | `60` | Room creates per minute for the whole process (burst: one minute's worth) |
| `ROOM_CREATES_PER_IP_PER_MINUTE` | `6` | Room creates per minute per client address. Defence in depth only: the address comes from the first `X-Real-IP`/`X-Forwarded-For` entry, which a client can forge unless the host's proxy overwrites it |
| `E2E_FIXTURES` | — | `1` mounts the browser smoke tests' fixture route (`src/e2e.ts`). Ignored when `NODE_ENV=production`. **Never set it on a deployed server** |

Do **not** set `E2E_FIXTURES`, `COLYSEUS_CLOUD`, `NODE_APP_INSTANCE`,
`REDIS_URI` or `COLYSEUS_LATENCY` on a deployed server: `@colyseus/tools` and
Colyseus read them and change how the server listens or behaves (see
[`../docs/preview-deployment.md`](../docs/preview-deployment.md)).

No secrets are required. `@colyseus/tools` reads an optional `.env` or
`.env.<NODE_ENV>` file; both are git-ignored.

## Deploying

The server is one long-lived Node.js process that holds a WebSocket per
player. It **cannot run on Vercel** (serverless functions do not keep
WebSockets open); the frontend stays on Vercel and points at it with
`VITE_COLYSEUS_URL`. Step-by-step instructions for a Preview test are in
[`../docs/preview-deployment.md`](../docs/preview-deployment.md).

**What the host must provide**

- Node.js 22+ (or a container runtime for the `Dockerfile`).
- Long-lived WebSocket connections (HTTP Upgrade passed through), with TLS
  terminated in front of the server so the browser connects with `https`/`wss`
  — an `https` page cannot use a plain `http` server.
- Exactly **one** instance, always on: room codes and live rooms are in process
  memory, so a second instance would split the rooms and scale-to-zero would
  end every match. (Scaling out needs Colyseus' Redis presence and driver.)
- The port in `PORT` (the server listens on it; default 2567).
- A health check on `GET /health` (200 `{"status":"ok",…}`).
- A stop signal of SIGTERM with a few seconds' grace: the server then disposes
  every room, tells every player it is shutting down (close code 4001) and
  exits 0 (`test/shutdown.test.ts`). A deploy therefore ends running matches.

**Native (no container)** — the path validated locally:

```sh
cd server
npm ci --include=dev
npm run build
NODE_ENV=production PORT=2567 ALLOWED_ORIGINS=https://<your-frontend-origin> npm run serve
```

`npm run serve` is `node build/index.js`. Keep `--include=dev` on hosts that
set `NODE_ENV=production` during the build (Render does): npm then skips
devDependencies, and the build needs TypeScript. The compiled server itself
needs only the runtime dependencies. Validated on Node 22.15 and 24.22 (the
whole test suite, and the compiled server in production mode).

`render.yaml` in the repository root describes this as a Render Blueprint
(free plan, `rootDir: server`, health check `/health`).

**Check a deployment** from any machine:

```sh
cd server
npm run check:hosted -- --server https://<server-host> --origin https://<preview-origin>
```

It checks `/health`, CORS for the Preview origin and for a foreign one, that
matchmaking and WebSocket upgrades refuse a foreign origin and accept the
Preview's, that `/monitor` and the test fixtures are absent, and that a room
can be created and joined. It prints no tokens and exits 1 on any failure.

**Container** — `Dockerfile` in this folder (Node 22, multi-stage, runs as the
`node` user, `HEALTHCHECK` on `/health`, `node` as PID 1 so it receives
SIGTERM directly):

```sh
docker build -t doodle-shooter-server server/
docker run --rm -p 2567:2567 -e ALLOWED_ORIGINS=https://<your-frontend-origin> doodle-shooter-server
```

> The Dockerfile has **not** been built or run yet: Docker was not available
> where it was written (later found installed in WSL, with its daemon
> stopped; starting it needs `sudo`). Its runtime stage (production-only `npm ci` from the
> lockfile, `NODE_ENV=production node build/index.js`) was reproduced natively
> and checked: `/health`, origin refusals, `/monitor` and the test fixtures
> absent, a two-client room. Build it once before relying on it.

**After deploying, check:**

```sh
curl https://<your-server-host>/health                       # {"status":"ok",...}
curl -i -X OPTIONS -H "Origin: https://<your-frontend-origin>"   https://<your-server-host>/matchmake/create/match           # names that origin
curl -i -X OPTIONS -H "Origin: https://example.com"   https://<your-server-host>/matchmake/create/match           # no Access-Control-Allow-Origin
```

## Origins

CORS headers name the caller's exact origin, with
`Access-Control-Allow-Credentials: true`, only when it is allowed; any other
origin gets neither header (never `*`).

Outside production, the Vite origins `http://localhost:5173`,
`http://127.0.0.1:5173`, `http://localhost:4173` and `http://127.0.0.1:4173`
are always allowed. In production, **only** `ALLOWED_ORIGINS` is: with it unset,
no browser can use the server (it logs a warning at startup). Vercel preview
deployments get their own URLs, so each one you want to test must be listed.

The list is enforced in three places: CORS headers name only an allowed origin,
matchmaking (`onAuth`) refuses other origins, and the WebSocket upgrade answers
them with 403 — the last one also covers reconnections, which skip matchmaking.

**Vercel previews.** Every deployment gets its own URL, and a branch also gets
a stable alias (`<project>-git-<branch>-<scope>.vercel.app`, shortened by
Vercel when it is long — copy it from the deployment's page). List the alias
of each branch you test, exactly. There is deliberately **no pattern support**
(such as `https://<project>-*.vercel.app`): project names on `vercel.app` are
first-come, so anyone can create a project whose URL matches a pattern built
from your project's name. `test/origins.test.ts` checks that look-alikes and
patterns are refused.

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
`isHost`, `ready`, `connected`, and the body: `spawned`, `x`, `y`, `z`, `yaw`,
`pitch`, `moving`, `alive`, `weapon`, `epoch`).

**Messages**

| Type | Payload | Who | Rule |
|---|---|---|---|
| `ready` | `{ ready: boolean }` | guests | lobby only; the host is always ready |
| `config` | `{ map?, grapple? }` | host | lobby only; unknown maps rejected |
| `start` | — | host | send with `room.request("start")`; answers `{ ok: true }` or `{ ok: false, reason }` |
| `move` | `{ x, y, z, yaw, pitch, moving, firing?, alive, weapon, epoch }` | everyone | playing only; see Movement (`alive` is ignored: the server decides it) |
| `fire` | `{ shot, weapon, origin, dir, ads, air, lag }` | everyone | see Combat |
| `slash`, `dash` | `{ shot, origin, dir, lag }` | everyone | katana; see Combat |
| `throw` | `{ shot, origin, dir }` | everyone | grenade; see Combat |
| `reload` | `{ weapon }` | everyone | starts a reload of that gun |
| `hazard` | `{ damage }` | everyone | a spike trap the client stood on; see Combat |
| `rematch` | — | host | resets health, scores and the winner; bumps `round` |

`start` is refused with `not-host`, `not-in-lobby`, `no-guests` (nobody to play),
`guest-reconnecting` (a guest's seat is held for a reconnection) or
`guests-not-ready`. On success `phase` becomes `playing`; lobby messages are
ignored from then on. Players can still join a running match, as with PeerJS.

A payload that fails validation disconnects its sender.

## Movement

The game's physics stays in the browser; a client proposes where its body is
and the server decides what everyone else sees (`src/movement.ts`).

- **Rate:** clients send `move` 20 times a second; the room patches state at
  the same rate (50 ms). More than 60 messages a second from one client
  disconnects it.
- **Shape:** every field is required; coordinates within ±10 000, angles within
  ±1 000, `weapon` ≤ 16 characters, `epoch` a non-negative integer. Anything
  else (NaN, Infinity, strings, missing fields) disconnects the sender.
- **Volume:** positions are clamped into the map's playable boxes, measured
  from the real map builders (`test/geometry.test.ts` rebuilds the maps and
  checks every zone, start pad and spawn point fits). The three Egyptian maps
  share one connected world, so each allows all three zones.
- **Speed:** ordinary movement draws on an allowance that refills at 60 m/s
  (sprint is 10.6, a dash briefly 36) with 30 m banked for packets that arrive
  bunched; a longer step is cut short toward the claim.
- **Teleports:** a change of the client's `epoch` (respawn, round restart,
  focus dash, Egyptian doors, the fall rescue) skips the speed limit, up to 3
  back to back and then 1 a second. Each accepted teleport bumps the synced
  `epoch`, so viewers snap instead of sliding.
- **Tidying:** yaw is wrapped to (−π, π], pitch clamped to ±π/2, unknown weapon
  names ignored. Moves before the start, or from a dropped seat, are ignored.
- **Spawn:** bodies start unplaced (`spawned: false`) when a match starts; a
  client's first move places it. After a reconnect the next move re-places it,
  because a reloaded page runs a fresh engine whose epochs restart.

What this does not do: walls are not checked for movement, so inside those
limits the client still chooses its path. `firing` is cosmetic (other players
draw muzzle puffs from it) and never decides anything.

## Combat

The server referees every attack (`src/rooms/Combat.ts`, rules in
`src/combat.ts`). A client sends what it did — "fired the rifle from here, that
way" — never what it hit; there is no message that claims damage or a kill.

- **The numbers are the game's.** Weapon stats come from the engine's rack
  (`src/game/arsenal.ts`; note `src/game/weapons.ts` is an older, different
  table the engine never read for guns), the katana from `KATANA_MELEE`, and
  hitboxes, range, spread, grenade physics, blast falloff, the focus dash,
  health, regen, the 3.2 s respawn and the 15-kill win from the engine and the
  lobby. `test/combat-parity.test.ts` fails if any of them drift.
- **Damage and health are player-versus-player values** (`PVP` in
  `src/game/arsenal.ts`), not the solo rack's, which is tuned against waves of
  enemies: 100 hp; rifle 9 (×2 head) = 12 body shots; shotgun 8 per pellet
  (×1.5), 80 point-blank; sniper 80 (×1.5) = 2 body shots or 1 headshot;
  revolver 30 (×2) = 4 body or 2 head; katana 40 (×1.5); focus dash 60; grenade
  60 centre (×1.5 for others). Fire rates, spread, magazines and reloads are
  the rack's. `test/combat-room.test.ts` checks the shots-to-kill.
- **Hits** are the engine's rays, ported line for line: per pellet, the server
  rolls the spread (hip or ADS, ×1.8 off the ground), stops the ray at the
  first wall of the shooter's zone (real map colliders, below), and tests the
  other bodies' head spheres and boxes. Damage is `damage × headMul` per
  pellet, applied once; one `hit` event per victim per shot.
- **Walls** come from `src/maps/colliders.json`, exported from the real map
  builders by `npx tsx scripts/export-colliders.ts` (re-run it after changing a
  map; the parity test fails if it is stale). Egyptian doors are left out:
  each player opens them in their own world, so the server treats them as open.
- **Firing rules:** the shooter must be placed, connected and alive, the match
  running and undecided; the shot's origin within 3 m of the shooter's eye; the
  aim a unit vector; the shot id higher than any before (duplicates and
  replays are dropped). Each weapon fires at its interval, with 150 ms of
  slack for network bunching; magazines empty and refill only after the
  weapon's reload time; switching weapons cancels a reload.
- **Lag compensation:** a shot is tested against the bodies as they were
  `lag` ms ago (the client's round trip + `100 ms, capped at 350 ms), and
  against where they are now.
- **Katana:** the engine's reach/arc cones; three landed cuts fill the focus
  meter, which opens a 2.6 s window for up to two dashes (60 damage).
- **Grenades:** the server flies the grenade with the engine's integration and
  sets it off after the 1.6 s fuse; everyone in the blast is hurt (×1.5 for
  everyone but the thrower), credited to the thrower.
- **Health and death:** 100 hp, regen 11 hp/s after 4.5 s without damage. At
  0 the player is down: a death, a kill for the attacker (none for erasing
  yourself), an `eliminated` event, and a respawn once 3.2 s have passed and
  the client re-places the body (or 2 s after that regardless). First to 15
  kills sets `winnerId` and stops combat until the host's `rematch`.
- **Order:** messages are processed one at a time in arrival order, so when
  two players fire at once the first shot processed lands and a player it
  kills can no longer fire.

What the server does not decide, and why:

- **Spike traps** run on each client's clock; a client reports one it stood
  on (exactly 12, at most every 850 ms, never on the surface or in the
  district). A client can only hurt itself this way — or skip reporting.
- **ADS and airborne** (which set the spread) are the client's report.
- **Reserve ammunition and grenade count** are not tracked: chests and
  pickups grant them in each client's own world. Magazines, reloads, fire
  rate and the grenade cooldown are enforced. **Chest healing does not apply**
  under server authority (the server owns health and cannot see chests).
- **Walls do not stop a katana or a blast** — they do not in the engine either.

Events: `hit` `{ attacker, victim, weapon, damage, head, kill, x, y, z }` (damage
is health actually taken) and `eliminated` `{ victim, killer, weapon }` (`killer`
is `""` for no credit).

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

**Who can get in.** A room's code is its only lock. Matchmaking exposes only
`create`, `joinById` and `reconnect` (`app.config.ts`); Colyseus' default `join`
and `joinOrCreate`, which seat the caller in *any* open room, are switched
off, and every room is private as well. Before 2026-10-24 both were open, so
anyone who could reach the server could join a stranger's match without its
code (`test/access.test.ts`).

**Creating rooms** is limited in three layers (`src/limits.ts`): the live-room
ceiling, a per-process budget and a per-address budget (see the variables
above). Refusals answer HTTP 429 with a reason the lobby shows, and are logged
as `{"event":"create-refused","reason":…,"liveRooms":…}` without the address.
The defaults are provisional until a load test measures one instance.
