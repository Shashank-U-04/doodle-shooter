# Colyseus cutover runbook

How to take online play from PeerJS to the Colyseus match server: first on a
Preview, then in Production. It also covers rollback. Commands are copied from
what was run while writing this. Dashboard steps (Vercel, Render) need someone
with access. Every step that changes Production or costs money needs explicit
approval first.

State on 2026-10-24 (see `baseline-2026-10-24.md`):

| | Commit | Transport |
|---|---|---|
| Vercel Production | `f8bb68b` (`main`) | PeerJS |
| Vercel Preview of `feat/multiplayer-gameplay-polish` | `4109ee0` | depends on the Preview variables' branch scope (unverified) |
| Render `doodle-shooter-match` | `dc14d7a` (branch `feat/colyseus-hosted-preview`) | — |

Open PRs, in merge order:
1. #1 `feat/multiplayer-gameplay-polish` → `main`
2. #2 `chore/ci-and-lockfile` → #1
3. #3 `chore/remove-startup-coupling` → #2
4. this runbook (`chore/cutover-runbook`) → #3

The server code is the same on all four branches except `scripts/check-hosted.ts`.

## 1. Align the Preview server with the client (manual, Render dashboard)

The `4109ee0` client expects 100 HP and the PvP damage table (S4d). Render runs
`dc14d7a` (120 HP, solo table). Until Render deploys a branch that contains S4d,
any Preview match is a mismatched pair.

1. Render → `doodle-shooter-match` → **Settings → Build & Deploy → Branch**:
   `feat/multiplayer-gameplay-polish`.
   - Root directory stays `server`.
   - Build `npm ci --include=dev && npm run build`.
   - Start `npm run serve`.
2. **Manual Deploy → Deploy latest commit.**
3. Verify:
   - The GitHub deployment record for the new commit shows success:
     ```sh
     gh api "repos/Shashank-U-04/doodle-shooter/deployments?per_page=3" \
       --jq '.[] | [.environment, (.sha[0:7]), .created_at] | @tsv'
     ```
   - `curl https://doodle-shooter-match.onrender.com/health` reports a small
     `uptime`, meaning the instance restarted.

Rollback: set the branch back to `feat/colyseus-hosted-preview` and deploy,
or use Render's **Rollback** on the previous deploy.

## 2. Allow the Preview origin (manual, Render dashboard)

`ALLOWED_ORIGINS` must list the **exact** origin testers open. Use the scheme
and host only, with no path and no trailing slash. Separate several with commas.

- Find the origin in Vercel → the deployment → **Domains**. The branch alias
  (`doodle-shooter-git-<branch…>-<team>.vercel.app`) stays fixed across pushes.
  A per-deployment URL changes with every push.
- On 2026-10-24 neither per-deployment URL (`…kxtbmbl1b…` for `dc14d7a`,
  `…pa6v44xze…` for `4109ee0`) was allowed. The live server answered CORS and
  WebSocket upgrades from both with 403. The earlier three-player test must
  have used another origin, probably the branch alias.
- After changing it, restart the service. The variable is read at startup.

## 3. Point the Preview at the server (manual, Vercel dashboard)

Vercel → Project → **Settings → Environment Variables**:

| Name | Value | Environment |
|---|---|---|
| `VITE_NET_TRANSPORT` | `colyseus` | **Preview only** |
| `VITE_COLYSEUS_URL` | `https://doodle-shooter-match.onrender.com` | **Preview only** |

- If these exist but are restricted to the branch `feat/colyseus-hosted-preview`,
  the new branches' Previews do not get them. Widen the scope to all Preview
  branches, or add one per branch.
- **Production must have neither.** Check that before merging #1. With either
  set in Production, the merge switches Production to Colyseus.
- These are build-time variables: redeploy the Preview after changing them.
- `VITE_VLY_APP_ID` and `VITE_VLY_MONITORING_URL` are no longer read by
  anything (removed in #3) and can be deleted.

How to tell which transport a Preview runs: the `/online` lobby's note reads
"the lobby runs on the match server" (Colyseus) or "play is peer-to-peer…"
(PeerJS).

## 4. Check the hosted server

```sh
cd server
npm run check:hosted -- --server https://doodle-shooter-match.onrender.com --origin https://<preview-origin>
```

Every line must say PASS. A run against the live server on 2026-10-24
(`dc14d7a`) found:

- **CORS and WebSocket refused the per-deployment Preview origins.** Fix with
  step 2.
- **Consented LEAVE never completes.**
  - Through Render, both players' `room.leave()` timed out after 5 s with no
    close event. The SDK then treats it as a drop and retries reconnection for
    about a minute.
  - Against a local server, with the same code, it completes in about 0.5 s
    with close code 4000.
  - Not yet diagnosed. Suspected: the close frame is lost between Render's
    proxy and the client. Re-test after step 1. If it persists, a player who
    leaves a hosted match keeps reconnecting in the background, which matters
    before Production.
- Passed: health, refusal of foreign origins (CORS, matchmaking and WebSocket),
  production mode (`/monitor` and test fixtures absent), and creating and
  joining a room by code.

## 5. Playtest the aligned Preview

Use `acceptance-checklist.md` with three or more players on Windows and macOS.
The S4d rebalance (100 HP) has not been played yet. Record:

- browsers and operating systems;
- join, rejoin and host migration;
- death, respawn, score, winner and rematch;
- whether LEAVE leaves cleanly (check the browser console for repeated
  reconnection lines);
- any connection loss (the client logs close codes, see `src/game/colyseus.ts`).

## 6. Production cutover (needs approval)

Each item below is an approval gate.

1. **Hosting cost.** The free Render instance sleeps after 15 minutes. It took
   32.5 s to answer from sleep on 2026-10-23, and it can be restarted at any
   time, which ends matches. An always-on instance (Render Starter, $7/month as
   of 2026-10-23) is the minimum for real players.
2. **Production origin.** Add the Production domain to `ALLOWED_ORIGINS` and
   restart.
3. **Merge** #1 → `main`, then the stacked PRs into it. Production deploys
   `main`. It stays on PeerJS until step 4 because nothing in Production sets
   `VITE_NET_TRANSPORT`.
4. **Switch.** Set `VITE_NET_TRANSPORT=colyseus` and `VITE_COLYSEUS_URL` for
   **Production** and redeploy.
5. **Verify.**
   - `npm run check:hosted -- --server … --origin https://<production-domain>`:
     all PASS.
   - The `/online` lobby says it runs on the match server.
   - A three-player match on the Production domain.

## 7. Rollback

### Frontend (Vercel)

| Situation | Action |
|---|---|
| Colyseus in Production misbehaves (after step 6.4) | Remove `VITE_NET_TRANSPORT` from Production and **redeploy**. Production returns to PeerJS; no code change. Vercel's Instant Rollback does **not** pick up variable changes. |
| A merged change breaks Production | Vercel → Deployments → the previous Production deployment → **Instant Rollback**. On the Hobby plan only the immediately previous deployment can be restored this way. Production's auto-assignment of the domain stops until you undo the rollback. |
| Revert in git | `git revert -m 1 <merge-commit>`, push, and Production redeploys. |
| Known-good code | Tag `rollback/production-f8bb68b` = the Production build of 2026-10-20 (deployment 7196675474). |

### Match server (Render)

| Situation | Action |
|---|---|
| A server deploy is bad | Render → Events → the previous deploy → **Rollback**. On Hobby, the last 5 builds are kept. |
| Back to the known pair | Set the branch to `feat/colyseus-hosted-preview` (`dc14d7a`) and deploy. |
| Matches during a deploy | A deploy replaces the instance. Players see CONNECTION LOST and must re-create the match. Deploy between sessions until match draining exists. |

### Verifying a rollback

After any rollback, check:
- the commit, via the deployment records (`gh api …/deployments`, above);
- the lobby's transport note;
- `/health`;
- for the server, `npm run check:hosted`.
