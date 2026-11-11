# Colyseus cutover runbook

How to take online play from PeerJS to the Colyseus match server: first on a
Preview, then in Production. It also covers rollback. Commands are copied from
what was run while writing this. Dashboard steps (Vercel, Render) need someone
with access. Every step that changes Production or costs money needs explicit
approval first.

State on 2026-11-11:

| | Commit | Transport |
|---|---|---|
| Vercel Production | `7f0e6fd` (`main`, deployed 2026-10-25) | PeerJS. Production has **not** switched to Colyseus. |
| Vercel Preview of `fix/hosted-restart-notice` (#11) | `17e5385` | the client build that matches the Render server below. It runs Colyseus when the Preview variables (step 3) cover this branch; the `/online` lobby note says which. |
| Render `doodle-shooter-match` | `17e5385` (tip of `fix/hosted-restart-notice`, #11), Node.js v24.22.2 | — |

- **Verified by hand:** Windows ↔ macOS multiplayer connectivity against the
  deployed Render server (`17e5385`, Node.js v24.22.2). The full acceptance
  checklist (`acceptance-checklist.md`) is not recorded as passed here. In
  particular, row 27 (server restart) has only been tested locally.
- **GitHub's deployment records do not show this deploy.** The last Render
  record (`gh api …/deployments`, step 1) is `dc14d7a` under the environment
  `feat/colyseus-hosted-preview - doodle-shooter-match`, dated 2026-11-05. The
  commits from `61b4b87` to `17e5385` carry `[skip render]`, so `17e5385` was
  deployed by hand. To confirm what Render runs, read the server's startup line
  in the Render logs. It has the form `{"event":"lifecycle",…,"node":…,"commit":…}`,
  and `commit` comes from `RENDER_GIT_COMMIT`.
- **CI:** all 12 PRs are open, and every check is green on each PR's current
  head. #1 has only the Vercel checks, because the Actions workflow arrives in
  #2.

Open PRs. Each targets the one before it, so it shows only its own change:

| PR | Branch → base | Depends on | What |
|---|---|---|---|
| #1 | `feat/multiplayer-gameplay-polish` → `main` | `main` (has `7f0e6fd` merged in) | the Colyseus migration S1–S4d |
| #2 | `chore/ci-and-lockfile` → `feat/multiplayer-gameplay-polish` | #1 | CI, one frontend lockfile, baseline record |
| #3 | `chore/remove-startup-coupling` → `chore/ci-and-lockfile` | #2 | no Convex/VLY at startup |
| #4 | `chore/cutover-runbook` → `chore/remove-startup-coupling` | #3 | this runbook, bounded `check:hosted` |
| #5 | `refactor/shared-rules` → `chore/remove-startup-coupling` | #3 (independent of #4) | one shared copy of the rules |
| #6 | `fix/room-access-and-limits` → `refactor/shared-rules` | #5 | **security**: codeless joins; room-creation limits |
| #7 | `feat/server-metrics` → `fix/room-access-and-limits` | #6 | one JSON metrics line a minute |
| #8 | `fix/teleport-destinations` → `feat/server-metrics` | #7 | **security**: teleports only to arrival points |
| #9 | `feat/perf-benchmark` → `fix/teleport-destinations` | #8 | frame-time benchmark and baseline |
| #10 | `fix/hosted-leave` → `feat/perf-benchmark` | #9 **and #4** (merged in by `23b591a`) | leaving a hosted room |
| #11 | `fix/hosted-restart-notice` → `fix/hosted-leave` | #10 | server-restart notice and detection; Render runtime pinned to Node.js 24 (`17e5385`) |
| #12 | `ci/e2e-artifacts` → `fix/hosted-restart-notice` | #11 (includes `17e5385`) | CI uploads Playwright traces and server logs; this runbook update |

```
main ← #1 ← #2 ← #3 ← #5 ← #6 ← #7 ← #8 ← #9 ← #10 ← #11 ← #12
                   └── #4 ───────────────────────────┘
```

#10 already contains #4's two commits, so #4's diff also shows up in #10. When
#10's content reaches `chore/remove-startup-coupling` (step 6.3), GitHub marks
#4 as merged.

The live server (`17e5385`) has both security fixes (#6 and #8), the client's
leave fix (#10) and the restart notice (#11). The two holes found on the old
server `dc14d7a` (October 2026) are fixed there. That build answered
`POST /matchmake/join/match` without a room code, and it accepted teleports to
any position. **Do not roll Render back to `dc14d7a`** except as a last resort
(see section 7).

The Preview the testers use must be a build of the same branch Render deploys,
so client and server match. For `fix/hosted-restart-notice`, the Preview origin
from Vercel's comment on PR #11 is
`https://doodle-shooter-git-fix-hos-b7c67e-shashank-us-projects-ca6e75e5.vercel.app`.
Branch aliases stay the same across pushes. They are behind Vercel
Authentication: testers need access to the Vercel project, or a share link
from the deployment's **Share** button.

## 1. Align the Preview server with the client (manual, Render dashboard)

Done for `17e5385` (see the state above). Repeat these steps only if Render
must deploy a different branch or commit.

1. Render → `doodle-shooter-match` → **Settings → Build & Deploy → Branch**:
   `fix/hosted-restart-notice` (#11: the migration, both security fixes, the
   leave fix and the restart notice). #12 adds nothing to `server/`. Keep the
   Vercel Preview on the same branch.
   - Optional server variables: `MAX_ROOMS`, `ROOM_CREATES_PER_MINUTE`,
     `ROOM_CREATES_PER_IP_PER_MINUTE` and `METRICS_INTERVAL_S` (see
     `server/README.md`). The defaults suit a playtest.
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
   - The Render log's `{"event":"lifecycle",…}` startup line shows the expected
     `commit` and `node` (v24.x). The deployment records above can lag behind a
     manual deploy.

Rollback: see section 7 (Match server).

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
- **Consented LEAVE never completed: diagnosed and fixed in the client (PR #10).**
  - **Cause.** Through Render, any WebSocket close the server starts is lost on
    the way to the client:
    - a consented leave's 4000;
    - a validation kick's 4002.
    The client gets nothing, then an abnormal 1006 about 20 s later. The SDK
    took that for a drop and retried reconnection for about a minute.
  - **Evidence (socket traces, 2026-10-24):**
    - Client-initiated closes complete through Render in about 90 ms.
    - Ping round trips work.
    - The server *did* process the leave: the room was gone 3 s later.
    - The deployed revision `dc14d7a`, built and started the way Render does
      under Node 24, closes cleanly locally.
  - **Fix.** `leaveRoom()` sends LEAVE and then closes from the client with
    4000, with reconnection off.
    - On Render: 4000 in 88–145 ms.
    - The other player's roster updated immediately.
    - No reconnection 25 s later.
  - **Restarts and deploys (PR #11).** Before closing every room, the server
    broadcasts a `server-closing` message and waits a second. In two real
    restarts on 2026-11-02 (build `b93f31b`, no wait yet) that message did **not**
    reach either player: they saw a late 1006 and 90–127 s of reconnecting. So
    clients now also ask `/health` while reconnecting, and show "The match server
    restarted…" as soon as a different server process answers. This has been
    tested locally only until row 27 of the acceptance checklist passes on Render.
    The `{"event":"lifecycle",…}` log lines show what happens during the restart.
  - **Still affected:** a validation kick reaches a hosted client as a late
    1006. Only a broken or hostile client is ever kicked.
  - `check:hosted` leaves the way the game does (all leave checks pass on
    Render) and reports, as INFO, that server-initiated closes are still lost.
- **Matchmaking error bodies are replaced on Render.**
  - Colyseus answers matchmaking errors with HTTP 520–524, the codes Cloudflare
    uses for its own errors, so Cloudflare swaps the JSON body for its error
    page.
  - The status code survives (an unknown code still shows "No match with code
    X"), but the message does not. A *full* room is reported as an unknown
    code on Render.
- Passed: health, refusal of foreign origins (CORS, matchmaking and WebSocket),
  production mode (`/monitor` and test fixtures absent), and creating and
  joining a room by code.

## 5. Playtest the aligned Preview

Use `acceptance-checklist.md` with three or more players on Windows and macOS.
Windows ↔ macOS connectivity against `17e5385` has been verified by hand. The
remaining rows, including the S4d rebalance (100 HP) and row 27 (server
restart on Render), still need results. Record:

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
3. **Merge, top-down, with "Create a merge commit".** Never squash or rebase:
   #10 and #4 share commits, and squashing breaks the stack's ancestry. Merge
   each PR into its own base, starting at the top. Then the whole migration
   reaches `main` in one merge, and Production builds only once. Merging #1
   first and then the stacked PRs into `main` would deploy Production up to 12
   times, including intermediate states. One of those is #1 without the #6/#8
   security fixes.

   **Before you start**, check Vercel → **Settings → Environment Variables**:
   Production must have neither `VITE_NET_TRANSPORT` nor `VITE_COLYSEUS_URL`
   (step 3).

   | # | Merge | Into | Note |
   |---|---|---|---|
   | 1 | #12 `ci/e2e-artifacts` | `fix/hosted-restart-notice` | **Render's branch.** Add `[skip render]` to the merge commit message, or the merge redeploys and restarts the live server. |
   | 2 | #11 `fix/hosted-restart-notice` | `fix/hosted-leave` | |
   | 3 | #10 `fix/hosted-leave` | `feat/perf-benchmark` | |
   | 4 | #9 `feat/perf-benchmark` | `fix/teleport-destinations` | |
   | 5 | #8 `fix/teleport-destinations` | `feat/server-metrics` | |
   | 6 | #7 `feat/server-metrics` | `fix/room-access-and-limits` | |
   | 7 | #6 `fix/room-access-and-limits` | `refactor/shared-rules` | |
   | 8 | #5 `refactor/shared-rules` | `chore/remove-startup-coupling` | |
   | 9 | #4 `chore/cutover-runbook` | — | already contained after row 8 (via #10); confirm GitHub shows it as merged |
   | 10 | #3 `chore/remove-startup-coupling` | `chore/ci-and-lockfile` | |
   | 11 | #2 `chore/ci-and-lockfile` | `feat/multiplayer-gameplay-polish` | |
   | 12 | #1 `feat/multiplayer-gameplay-polish` | `main` | the only Production deploy; needs approval |

   - Wait for green CI on the next PR after each merge. Every merge changes
     that PR's base, and CI re-runs.
   - Leave **Delete branch on merge** off until the end. Render deploys
     `fix/hosted-restart-notice`, and `feat/colyseus-hosted-preview` is a
     rollback target.
   - Production deploys `main`. It stays on PeerJS until step 4, because
     nothing in Production sets `VITE_NET_TRANSPORT`.
   - The server code that reaches `main` is the same as `17e5385`'s `server/`.
     #12 changes only CI and docs, and `7f0e6fd` changes only `.gitignore` and
     `.env.keys`. Moving Render's branch to `main` after the merge therefore
     changes no server code. It is still a deploy, which ends running matches.
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
| A merged change breaks Production | Vercel → Deployments → the previous Production deployment (today `7f0e6fd`, 2026-10-25) → **Instant Rollback**. On the Hobby plan only the immediately previous deployment can be restored this way. Production's auto-assignment of the domain stops until you undo the rollback. |
| Revert in git | `git revert -m 1 <merge-commit>` (the #1 → `main` merge), push, and Production redeploys `7f0e6fd`'s code. |
| Known-good code | `7f0e6fd` = the current Production build (`main`, PeerJS). Tag `rollback/production-f8bb68b` = the Production build of 2026-10-20 (deployment 7196675474). Its tree still contains `.env.keys`, which `7f0e6fd` removed. Redeploy that build in Vercel; never reset `main` to the tag. |

### Match server (Render)

| Situation | Action |
|---|---|
| A server deploy is bad | Render → Events → the previous deploy → **Rollback**. On Hobby, the last 5 builds are kept. |
| Back to the verified pair | Server `17e5385` on branch `fix/hosted-restart-notice`, Node.js 24, with that branch's Vercel Preview. Redeploy that commit. |
| Last resort | Branch `feat/colyseus-hosted-preview` (`dc14d7a`). It is pre-S4d (120 HP), lacks the #6/#8 security fixes and does not match the current clients. Use it only if nothing newer starts. Keep that branch until the cutover is complete. |
| Matches during a deploy | A deploy replaces the instance, and players must re-create the match. With #11 they should see "The match server restarted…", but that is verified locally only until checklist row 27 passes on Render. Deploy between sessions until match draining exists. |

### Verifying a rollback

After any rollback, check:
- the commit, via the deployment records (`gh api …/deployments`, above);
- the lobby's transport note;
- `/health`;
- for the server, `npm run check:hosted`.
