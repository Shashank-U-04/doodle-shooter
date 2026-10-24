# Testing the Colyseus transport on a Vercel Preview

How to try the Colyseus migration on a Vercel **Preview** deployment, with the
match server hosted separately. Nothing here touches Production: PeerJS stays
the transport of every Production build, and Production environment variables
are not changed.

Placeholders, to fill in with your own values:

| Placeholder | Meaning |
|---|---|
| `<server-host>` | Public HTTPS host of the match server, as your Node host assigns it |
| `<preview-origin>` | The Preview's origin: `https://…vercel.app`, no path, no trailing slash |

## What is already known (checked 2026-10-21)

- Vercel's GitHub integration builds a Preview for every push to a feature
  branch (project `doodle-shooter`, team scope `shashank-us-projects-ca6e75e5`,
  from the deployment records GitHub holds). Production builds come from `main`.
- Each push gets a **per-deployment URL** (for `868650e`:
  `https://doodle-shooter-1re3fqzxz-shashank-us-projects-ca6e75e5.vercel.app`)
  that changes with every push. A **branch alias** also exists but is not in
  GitHub's data, and for a branch name this long Vercel shortens it: copy it
  from the deployment's page in the Vercel dashboard rather than composing it.
- **Previews are behind Vercel Authentication** (they redirect to Vercel's
  sign-in). Testers on other devices must be signed in to Vercel with access
  to the project, or you must share the Preview through Vercel's own
  sharing/bypass options. This does not affect the match server: the browser
  still sends the Preview's origin.
- The current Previews were built **without** the Colyseus variables, so they
  run PeerJS until the variables below are added and the Preview is rebuilt.

## 1. Choose a host for the match server

The server is one always-on Node.js 22 process with WebSockets
([`server/README.md` → Deploying](../server/README.md#deploying)). It cannot run
on Vercel. Measured locally (production build): ~77 MB RSS idle and ~67 MB with
10 full rooms (40 players moving at 20 Hz) — a 256 MB instance is enough.

| Host | Cost (as published, Oct 2026) | Fit for this Preview test |
|---|---|---|
| Render, free web service | $0; 750 instance-hours/month per workspace | Works for a supervised session: native Node build, WebSockets. **Spins down after 15 min without traffic** (WebSocket messages count) and takes about a minute to wake; Render may restart free services at any time, which ends running matches |
| Fly.io, shared-cpu-1x 256 MB | $2.19/month (Ashburn/Secaucus; other regions differ); no free tier, trial of 2 h machine time or 7 days; card required after the trial | Always on; deploys the `Dockerfile` (not validated yet — see below) |
| Railway, Hobby | $5/month subscription including $5 of usage | Always on; native or Dockerfile |
| Colyseus Cloud | from $15/month; no free tier | **Not usable as is**: it runs one process per CPU behind PM2/Redis, and this server keeps room codes in one process's memory (`liveCodes`). Needs Redis presence/driver work first |

Recommendation for the first acceptance session: **Render free** (no cost; the
native start path is the one validated locally). Open `/health` a minute before
testing to wake it. If spin-downs or restarts get in the way, move to **Fly.io
256 MB** (~$2.19/month) after the Dockerfile has been built once.

Nothing has been purchased or configured on any of these.

## 2. Server environment (exact names the code reads)

| Variable | Value | Read by |
|---|---|---|
| `NODE_ENV` | `production` — required: drops the dev origins, `/monitor` and the test fixtures | `server/src/origins.ts`, `app.config.ts`, `e2e.ts` |
| `ALLOWED_ORIGINS` | `<preview-origin>`; comma-separate several; exact origins only | `server/src/origins.ts` |
| `PORT` | whatever the host requires (default 2567) | `@colyseus/tools` `listen()` |

Must **not** be set on a deployed server:

| Variable | Why |
|---|---|
| `E2E_FIXTURES` | mounts the smoke-test fixture route (also refused when `NODE_ENV=production`) |
| `COLYSEUS_CLOUD` | switches `listen()` to a Unix socket under `/run/colyseus` and to Colyseus Cloud's Redis setup |
| `NODE_APP_INSTANCE` | `listen()` adds it to `PORT` (PM2 cluster mode sets it) |
| `REDIS_URI` | only used with `COLYSEUS_CLOUD`; the server is single-process |
| `COLYSEUS_LATENCY` | adds simulated latency to every message |

No secrets are needed.

**Render (recommended first host): use the Blueprint.** `render.yaml` in the
repository root defines the service: free plan, root directory `server`, build
`npm ci --include=dev && npm run build`, start `npm run serve`, health check
`/health`, `NODE_ENV=production`, and `ALLOWED_ORIGINS` prompted at creation.
Check `region` (fixed after creation) before applying it.

> The build command needs `--include=dev`. Render passes `NODE_ENV=production`
> to the build too, and npm then skips devDependencies; a plain
> `npm ci && npm run build` fails (`rimraf` / `tsc` not found). Reproduced
> locally, and the fixed command verified, including the start on Render's
> default `PORT` 10000.

Render's default Node for new services is 24; the server suite and the
compiled server were also run on Node 24.22, so no `NODE_VERSION` is needed.
Container hosts: build `server/Dockerfile` with `server/` as the context.

Check it:

```sh
cd server
npm run check:hosted -- --server https://<server-host> --origin <preview-origin>
```

Ten checks: health, CORS for the Preview and for a foreign origin, matchmaking
and WebSocket refusals of a foreign origin, the Preview's WebSocket accepted,
no `/monitor`, no test fixtures, and a room created and joined. Before the
Preview origin is known, run it with any placeholder origin: only the three
Preview-origin checks fail.

## 3. Vercel Preview environment

In the Vercel project → Settings → Environment Variables, add for the
**Preview** environment only (optionally restricted to the branch under test):

| Variable | Value | Read by |
|---|---|---|
| `VITE_NET_TRANSPORT` | `colyseus` | `src/game/transport.ts` |
| `VITE_COLYSEUS_URL` | `https://<server-host>` (https, no trailing path) | `src/game/transport.ts` |

Leave everything else as it is. For reference, the frontend also reads
`VITE_CONVEX_URL` (`src/main.tsx`, required for the app to boot),
`VITE_CONVEX_SITE_URL`, `VITE_TURN_URLS`, `VITE_TURN_USERNAME`,
`VITE_TURN_CREDENTIAL`, `VITE_TURN_CREDENTIALS_URL`, `VITE_NET_DEBUG`
(`src/game/net.ts`) and `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`,
`VITE_PEER_KEY`, `VITE_PEER_SECURE` (`src/game/signaling.ts`) — all for the
PeerJS path or Convex, none needed by Colyseus. `VITE_VLY_APP_ID` and
`VITE_VLY_MONITORING_URL` appear only in `src/instrumentation.tsx`, which
nothing imports.

These are build-time variables: **redeploy** the Preview after adding them.
Production keeps none of them, so Production stays on PeerJS.

### Install command

Vercel picks the package manager from the lockfile (`bun.lock` → `bun install`
for Bun ≥ 1.2). This repo has two root lockfiles, and Vercel's documentation
does not say which wins:

- `bun.lock` is current: a clean clone of `868650e` installs with
  `bun install --frozen-lockfile` (Bun 1.3.14, lockfile unchanged) and builds.
- `package-lock.json` is stale: `npm ci` fails (missing `three`, `peerjs`,
  `@colyseus/sdk`, `@playwright/test`, …). Plain `npm install` would ignore
  the lock and resolve fresh versions.

Open the latest Preview's build log and confirm the install step runs
`bun install`. If it runs npm, set the install command (Project → Settings →
Build and Deployment) to `bun install` — that is a dashboard change for you
to make; removing the stale `package-lock.json` is a separate decision.

## 4. Allow the Preview's origin

Take the origin the testers will open (branch alias or per-deployment URL),
set it in `ALLOWED_ORIGINS`, and restart the server. Then:

```sh
curl -i -X OPTIONS -H "Origin: <preview-origin>" https://<server-host>/matchmake/create/match
# → Access-Control-Allow-Origin: <preview-origin>
```

## 5. Check the Preview, then run the acceptance test

1. Open `<preview-origin>/online`. The lobby note reads "the lobby runs on the
   match server". In the browser's network tab the WebSocket goes to
   `wss://<server-host>`; there is no PeerJS or TURN traffic.
2. Run [`acceptance-checklist.md`](acceptance-checklist.md) on Windows and
   macOS, on separate networks.

If the lobby says it cannot reach the match server: `/health`, then the exact
origin in `ALLOWED_ORIGINS` (scheme, host, no trailing slash), then that
`VITE_COLYSEUS_URL` is https and the Preview was rebuilt after setting it.

What players see when the free host misbehaves (both covered by
`e2e/colyseus-failures.spec.ts`):

- **Asleep:** after 5 s the lobby shows "WAKING THE MATCH SERVER — A SLEEPING
  SERVER CAN TAKE UP TO A MINUTE…", then opens the room when it answers.
- **Restarted** (redeploy, Render recycling the instance): both arenas stop
  and show CONNECTION LOST — "The match server restarted, so this match has
  ended." — with a button back to the menu.

**Confirm the Preview really uses Colyseus** (a build without the variables
silently stays on PeerJS): on `/online` the lobby's note reads "the lobby runs
on the match server" (PeerJS: "play is peer-to-peer…"); creating a room sends
`POST https://<server-host>/matchmake/create/match` and opens a
`wss://<server-host>/…` socket in the Network tab; in the arena the feed shows
"COLYSEUS PREVIEW — THE MATCH SERVER REFEREES EVERY SHOT".

## What has and has not been verified

- **Verified locally (S4c):** Render's build and start reproduced with
  `NODE_ENV=production` (the original build command failed; fixed), the
  server on Node 24, `check:hosted` against that simulated deployment (all
  pass; a wrong origin fails exactly the three origin checks), the wake-up
  hint and the restart screen in Chromium, and clean room disposal on
  shutdown (no unhandled rejections).
- **Verified locally:** the native production start path (production-only
  install, `NODE_ENV=production node build/index.js`: health, origin refusals,
  no `/monitor`, no test fixtures, a two-client room, memory use); graceful
  SIGTERM shutdown (`server/test/shutdown.test.ts`); clean `bun install
  --frozen-lockfile` + build of the frontend; the lobby → arena → winner → host
  migration → rematch flow and a guest reload, in Chromium, against a local
  server and a local production build (`e2e/`).
- **Not verified:** the Dockerfile (Docker is installed in WSL but its daemon
  needs `sudo` to start); any hosted deployment; a real Vercel Preview with the
  Colyseus variables; which install command Vercel runs; Safari/Firefox;
  separate devices and networks.
