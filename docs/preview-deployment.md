# Testing the Colyseus transport on a Vercel Preview

How to try the Colyseus migration on a Vercel **Preview** deployment, using a
separately hosted match server. Nothing here touches Production: PeerJS stays
the transport of every Production build, and Production environment variables
are not changed.

Placeholders, to fill in with your own values:

| Placeholder | Meaning |
|---|---|
| `<server-host>` | Public HTTPS host of the match server, e.g. what your Node host assigns |
| `<preview-origin>` | The Preview's origin, `https://…vercel.app`, no trailing slash |
| `<branch>` | The Git branch being previewed |

## 1. Deploy the match server (`server/`)

Pick a host that runs a long-lived Node.js 22 process (or a container) with
WebSockets and TLS. Vercel cannot host it. Requirements and commands are in
[`server/README.md` → Deploying](../server/README.md#deploying); in short:

- build: `npm ci && npm run build` (in `server/`), start: `npm run serve` —
  or build the `server/Dockerfile` (not yet validated, see below)
- one instance, always on; health check `GET /health`; stop with SIGTERM
- environment:

  | Variable | Value |
  |---|---|
  | `NODE_ENV` | `production` |
  | `PORT` | whatever the host requires (default 2567) |
  | `ALLOWED_ORIGINS` | `<preview-origin>` (comma-separate several; exact origins only) |

  Do **not** set `E2E_FIXTURES`. No secrets are needed.

Check it: `curl https://<server-host>/health` answers `{"status":"ok",…}`.

## 2. Find the Preview origin

Push the branch; Vercel builds a Preview. Use the branch alias shown on the
deployment's page (stable across pushes to that branch), e.g.
`https://<project>-git-<branch>-<scope>.vercel.app`. A per-deployment URL also
works but changes on every push. Add the origin you will use to
`ALLOWED_ORIGINS` on the server and restart it.

## 3. Point the Preview at the server

In the Vercel project → Settings → Environment Variables, add for the
**Preview** environment only (optionally restricted to `<branch>`):

| Variable | Value |
|---|---|
| `VITE_NET_TRANSPORT` | `colyseus` |
| `VITE_COLYSEUS_URL` | `https://<server-host>` (https: the page is https) |

Leave the Production environment's variables as they are. These are build-time
variables (Vite inlines them), so **redeploy** the Preview after adding them.
The existing Preview values for Convex (`VITE_CONVEX_URL`, …) stay as they are.

Before trusting the build, open its build log and note which package manager
installed dependencies (`bun.lock` is the maintained lockfile; the root
`package-lock.json` is stale). This has not been verified yet.

## 4. Check the Preview

1. Open `<preview-origin>/online` in two browsers. The lobby's note reads
   "the lobby runs on the match server".
2. Create a room in one, join with the code in the other, ready up, enter the
   arena. Both see each other move; shots register; the feed and scores agree.
3. Play to 15 (or have the host leave mid-match and rematch from the promoted
   guest). Reload a tab mid-match: it comes back to the same seat.
4. In the browser's network tab the WebSocket goes to `wss://<server-host>`, and
   no PeerJS / TURN traffic appears.

If the lobby says it cannot reach the match server, check in this order:
`/health`, that `<preview-origin>` is listed exactly in `ALLOWED_ORIGINS`
(scheme, host, no trailing slash), and that `VITE_COLYSEUS_URL` is https.

## 5. Cross-device acceptance (before any merge)

Run step 4 on a Windows and a macOS machine, on separate networks (e.g. home
Wi-Fi and a phone hotspot), with at least one full match and one reload each.
Record browser versions and results in the PR.

## What has and has not been verified

- **Verified locally:** the native production start path (production-only
  install, `NODE_ENV=production node build/index.js`: health, origin refusals,
  no `/monitor`, no test fixtures, a two-client room); graceful SIGTERM
  shutdown (`server/test/shutdown.test.ts`); the full lobby → arena → winner →
  host migration → rematch flow in Chromium against a local server and a local
  production build (`e2e/colyseus-match.spec.ts`).
- **Not verified:** the Dockerfile (no Docker was available); any hosted
  deployment; a real Vercel Preview; Vercel's install command; Safari/Firefox;
  separate devices and networks.
