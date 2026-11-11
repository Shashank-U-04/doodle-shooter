# Colyseus migration — design and behaviour map

Target: React + Three.js frontend on Vercel, Colyseus (Node.js, WebSockets) for
multiplayer. PeerJS, WebRTC/TURN and Convex stay in place until each of their
responsibilities has a verified replacement.

Baseline for this migration: `main` at `f8bb68b`.

## How online play works today

`src/game/net.ts` (`NetSession`) runs a **star over WebRTC data channels**
brokered by the public PeerJS server. The host's peer id is `ds-pvp-<CODE>`, so
a 4-letter code is all a guest needs. Guests talk only to the host; the host
relays. Convex is used for auth and for minting TURN credentials
(`src/convex/turn.ts`); it carries no game traffic.

Authority is split:

- **Each player owns their own body**: position, health, alive/dead, respawn.
- **The shooter decides a hit connected** and reports it; the **victim**
  validates it (`engine.takeNetHit`: epoch check, lag-rewound pose, body
  capsule, line of sight against the world, range ≤ 170, dmg ≤ 300) and applies
  the damage.
- **The host owns** the roster, ink colours, ready flags, match config, the
  4-player limit and the start/rematch signals.
- **Scores are not owned by anyone**: every client counts `death` messages
  itself, and the winner (first to 15 kills, `Online.tsx`) is derived locally.

## Behaviour → Colyseus mapping

Status: **S1** = server foundation (`server/`); **S2** = lobby over Colyseus behind
`VITE_NET_TRANSPORT=colyseus` (`src/game/colyseus.ts`); **S3A** = player movement
(`server/src/movement.ts`); **S3B** = combat (`server/src/rooms/Combat.ts`);
**S4+** = later.

| Behaviour today (PeerJS) | Where | Colyseus replacement | Status |
|---|---|---|---|
| Host creates room; 4-letter code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` | `room.ts drawRoomCode`, `Online.tsx create` | `client.create("match", {name, map, grapple})`; server draws the code, uses it as `roomId`, guarantees uniqueness among live rooms | S1 |
| Code survives a reload of the host tab (sessionStorage lease) | `room.ts` lease | Reconnection token kept per tab in sessionStorage (`dd_colyseus_seat`); seat held 30 s server-side | S2 ✓ |
| Guest joins by code; code normalised to `A-Z0-9`, 3–8 chars | `room.ts`, `Online.tsx join` | `client.joinById(code)` after the same normalisation | S2 ✓ |
| Unknown code: guest times out after dial retries | `dialHost`, `retryOrReport` | `joinById` rejects immediately ("room not found") | S1 |
| Room full: host answers `full`, guest closes | `receive("hello")` | `maxClients` (4, or 2–4 if requested); join rejected by matchmaker | S1 |
| `hello {name}` → roster entry, name ≤ 16 chars | `receive("hello")` | `onJoin(options.name)`; name sanitised (control chars stripped, trimmed, ≤ 16) | S1 |
| Ink 0–5, lowest free | `freeInk` | Same rule, server-side; part of `Player` schema | S1 |
| `roster` broadcast (id, name, ink, ready) | `sendRoster` | `MatchState.players: MapSchema<Player>` synced automatically | S1 |
| `ready {ready}` guest → host; host always ready | `setReady`, `receive("ready")` | `ready` message, zod-validated; ignored from host or outside lobby | S1 |
| `config {map, grapple}` host-only, normalised | `setConfig`, `normalizeMatchConfig` | Create options normalised like the client; `config` message host-only, lobby-only, map whitelist | S1 |
| Start button: host only, needs ≥ 1 guest, all guests ready | `Online.tsx allReady`, `beginMatch` | `start` request: server checks host, lobby phase, ≥ 1 guest, none reconnecting, all ready; sets `phase = "playing"`; refusals shown in the lobby | S2 ✓ |
| Mid-match joiner drops straight into the arena | `receive("hello")` while playing | Room stays unlocked; `phase` in state tells the joiner | S2 ✓ |
| Guest leaves (`bye` or channel close) → removed, feed "X LEFT" | `drop` | `onLeave` removes the player; client derives the feed line from the state diff | S1 (server) |
| Silent peer dropped after 12 s while playing | `sweepSilent` | WebSocket close / ping timeout; then `allowReconnection` window (30 s) | S2 ✓ |
| **Host leaves → the room is dead**; guests retry twice, then error | `drop(hostId)`, `scheduleRejoin` | **Changed:** server owns the room, so the longest-standing guest becomes host. Needs review — see "Decisions" | S1 |
| Guest lobby rejoin after dropped channel (2 tries) | `scheduleRejoin` | `allowReconnection(client, 30)` in `onDrop`; SDK auto-reconnect for transient drops; `client.reconnect(token)` after a reload | S2 ✓ |
| `state` 20 Hz per player: x,y,z,yaw,pitch,hp,alive,moving,firing,weapon,epoch,seq | `tick`, `NetPlayerState` | `move` message, zod-validated; server clamps to the map volume, speed-limits, rate-limits teleports (epoch changes) and keeps its own epoch; body synced in `Player` (`firing` cosmetic, `hp` server-owned) | S3A ✓ |
| Host folds every body into one `states` packet per tick | `tick` (host) | Room state patches at 50 ms (20 Hz) carry every changed body | S3A ✓ |
| `hit {victim, dmg, epoch, origin}`: the shooter decides it hit | `fireWeapon`, `receive("hit")` | **Replaced:** clients send `fire`/`slash`/`dash`/`throw` intents; the server decides hits with the engine's rays, hitboxes and the real map walls, and applies damage | S3B ✓ |
| Victim validates hit against rewound pose + world raycast | `engine.takeNetHit` | Server-side lag compensation (body history, ≤ 350 ms) | S3B ✓ |
| `death {killer}` → everyone bumps kills/deaths, feed | `apply("death")`, `reportDeath` | Server owns health, `kills`/`deaths`; `eliminated` event drives the feed | S3B ✓ |
| First to 15 kills wins (derived per client) | `Online.tsx KILLS_TO_WIN` | Server sets `winnerId` and stops combat; the arena's overlay shows the server's winner (`matchWinner`), even if they have left | S3C ✓ |
| `respawn {epoch}` after 3.2 s; spawn pad = ink at start | `Online.tsx` | Server revives after 3.2 s when the client re-places the body; spawn choice stays on the client | S3B ✓ |
| `rematch` host-only: scores cleared, engine reset | `rematch`, `beginRematch` | `rematch` message, host-only; server resets and bumps `round`; the button follows the current host, so a promoted guest can rematch | S3C ✓ |
| `ping`/`pong` every 2 s → half-RTT feeds aim lead/rewind | `startPinging`, `noteRtt` | SDK `room.ping` every 2 s; sent as each attack's `lag` for server-side rewind (the engine no longer leads targets) | S3B ✓ |
| TURN credentials, ICE plan, signaling diagnostics | `net.ts`, `signaling.ts`, `convex/turn.ts` | Not needed over WebSockets; retired with PeerJS | S5 |
| Convex auth (`@convex-dev/auth`) | `src/convex/auth*`, `use-auth.ts` | Out of scope; keep until a persistence/auth decision (Supabase deferred) | later |

## What cannot move to the server yet

- **Movement and collision.** Physics (`world.ts resolveMove`, grapple, focus
  dash, crouch, depenetration) runs in the engine on the client. S3A keeps it
  there: the server clamps each proposed position to the map's volume (boxes
  measured from the real builders), limits speed and rate-limits teleports, but
  does not check walls. Server-side collision needs the map colliders built
  headlessly — feasible (`server/test/geometry.test.ts` and
  `scripts/check-valley.ts` already build the real maps without a renderer) —
  but it means a second physics step on the server and client-side
  reconciliation, which would change movement feel.
- **Per-player world state.** Egyptian doors, spike traps, chests and pickups
  live in each client's own world. S3B treats doors as open on the server,
  takes spike hits as validated self-reports, does not apply chest healing, and
  does not track reserve ammunition or grenade counts (magazines, reloads, fire
  rate and the grenade cooldown are enforced). Making them server-side means
  moving that map state to the server.

## Decisions needing review

1. **Host migration.** Today the room dies with its host. The server promotes the
   longest-standing guest instead. Easy to revert: dispose the room when the
   host leaves.
2. **Malformed messages disconnect the sender.** This is Colyseus' default for a
   payload that fails its validator. A real client never sends one.
3. **Room codes are server-drawn.** The PeerJS reload-resume lease reuses a
   client-held code; under Colyseus a reconnection token does that job (S2).
4. **Single process.** Code uniqueness is tracked in memory, which is correct
   for one server process. Scaling out needs Redis presence and driver.
5. **Erasing yourself scores no kill (S3B).** The PeerJS code gives the victim a
   kill for their own grenade (`reportDeath` bumps the victim's kills when the
   killer is themselves). The server counts a death and no kill.
6. **Shots stay in the shooter's zone (S3B).** The engine tests every remote
   body regardless of zone, and the surface floor is too low to stop a round,
   so a shot straight down could hit a player 140 m below in the sanctuary. The
   server only tests bodies in the shooter's zone.

## Open issues found during S2

- **Vercel's install command is unverified.** `bun.lock` is the maintained
  lockfile (it changes with `package.json` and contains `peerjs`); the root
  `package-lock.json` has not changed since the first commit and lacks `peerjs`.
  S2 added `@colyseus/sdk` to `package.json` and `bun.lock` only. Whether
  Vercel runs `bun install` or `npm install` has not been checked in its
  dashboard; until it has, production readiness of this branch is not claimed.
  *S4b:* a clean clone installs with `bun install --frozen-lockfile` and
  builds; `npm ci` against `package-lock.json` fails (out of sync). Vercel's
  build log still has to confirm which one it runs (`preview-deployment.md`).
- **`?code=` collides with Convex Auth (all transports).** `ConvexAuthProvider`
  treats a `code` query parameter as its OAuth/magic-link callback: on every page
  load it deletes it from the URL and calls `signIn` with it. A guest's
  `/online?code=XXXX` link works on first load only because the lobby reads the
  parameter first; after a reload the code is gone (PeerJS guests land on the
  menu), and every invite sends the room code to Convex as a sign-in code. The
  Colyseus lobby resumes from its stored seat instead of the URL, so it is not
  affected. Fix (not applied — it touches auth and the PeerJS default): pass
  `shouldHandleCode` to `ConvexAuthProvider` so `/online` is skipped, or rename
  the lobby's parameter (e.g. `room=`).
  *S4b — worse than described, and fixed without touching auth.* From the
  installed `@convex-dev/auth` 0.0.90: the provider calls `signIn(undefined,
  { code })`; the server's `verifyCodeAndSignIn` returns null for a room code,
  the response carries `tokens: null`, and the client stores that — **joining a
  room by link signed the player out** (any session, anonymous included). The
  app's only providers are email OTP (typed in a form) and Anonymous, so no
  legitimate sign-in arrives as `?code=`. Setup now sends guests to
  `/online?room=XXXX` (`ROOM_PARAM` in `src/game/room.ts`); the lobby reads it
  once and removes it from the URL, so reloads behave exactly as before on both
  transports. Old `?code=` links still join (and still reach Convex Auth, as
  before). `ConvexAuthProvider` is unchanged.
- **Pre-existing quirks the server reproduces faithfully (S3B):** a chest-high
  katana cut at arm's length always counts as a head cut (the head cone
  contains the chest), so one slash erases; grenades bounce at the absolute
  height 0.12, so one thrown underground jumps to surface height; after two
  focus dashes the meter stays locked until a round restarts.
- **Pre-existing in the PeerJS path (not changed):** the victim rejects any hit
  over 300 (`takeNetHit`), so sniper headshots (450) never land there; and
  `src/game/weapons.ts` disagrees with the engine's real weapon table (now
  `src/game/arsenal.ts`).
- **Bundle size.** The Colyseus SDK is loaded with a dynamic `import()` when a
  Colyseus session connects, so PeerJS builds do not download it. The `/online`
  chunk grows by about 2 KB gzipped for the adapter itself.

## Remaining gaps (audit after S3B, ordered by dependency)

1. **Deployment (S4).** S4a prepared it (Dockerfile, native start path,
   shutdown, docs in `preview-deployment.md`); still open: choosing a host,
   deploying the server, the Preview env vars, building the Dockerfile once,
   and checking Vercel's install command (bun vs npm).
2. **Abuse limits.** Anyone on an allowed origin (or no origin) can create rooms
   without limit; there is no per-IP cap on room creation or connections.
3. **Browser regression tests.** S4a added a Chromium smoke test for the
   Colyseus flow (below). Still open: PeerJS in a browser, Firefox/WebKit, and
   real aiming (the test's 15th kill comes from a server fixture).
4. **Runtime fallback.** The transport is a build flag, so a Colyseus preview
   cannot fall back to PeerJS without a rebuild.
5. **Movement collision.** The server clamps volume and speed but does not stop
   a client walking through walls; the colliders it already has for shots could
   check each step's segment (with tolerance for depenetration and doors).
6. **Map interactions.** Doors, spike traps, chests, pickups, reserve ammo and
   grenade counts are per-client; chest healing does not apply under server
   authority.
7. **`?code=` vs Convex Auth** — fixed in S4b by the `?room=` parameter (above);
   no auth change.
8. **Identity.** Colyseus seats are anonymous; names are self-reported. Binding a
   seat to a Convex user is not designed yet (and not needed to replace PeerJS,
   which is also anonymous).
9. **Retirement (S5)** — only after the above and the two-device, two-network
   acceptance test.

## Browser smoke test

`e2e/colyseus-match.spec.ts` (Playwright, Chromium) runs two players in
separate browser contexts through create → join → ready → arena → winner →
host leaves → promoted guest rematches, against a local match server
(`server/src`, with `E2E_FIXTURES=1`) and a local production build of the
frontend (`VITE_NET_TRANSPORT=colyseus`). `VITE_CONVEX_URL` points at a closed
local port and every request leaving 127.0.0.1 is aborted, so it reaches no
Convex deployment, PeerJS broker or other service.

```sh
bun install && (cd server && npm ci)
bunx playwright install chromium     # or: npx playwright install chromium
bun run test:e2e                      # or: npx playwright test
```

- Ports 2599 (server) and 5199 (frontend) must be free; the build goes to
  `e2e/.dist`, traces and screenshots to `e2e/.results` (both git-ignored).
- On Windows, run it from the repository path with its exact on-disk casing
  (e.g. `…\GitHub\…`, not `…\Github\…`): a differently cased working
  directory makes Playwright load twice and report "did not expect test() to be
  called here".
- The 15th kill is a fixture (`server/src/e2e.ts`): a browser cannot aim. The
  fixture is mounted only with `E2E_FIXTURES=1` outside production.
- **PeerJS is not covered**: a browser test of it needs a signaling broker, and
  the default is the public PeerJS cloud. Covering it means running a local
  PeerServer (`VITE_PEER_HOST`/`PORT`/…) — a new dev dependency, left for a
  later change.

## Milestones

- **S1 (this change):** `server/` workspace: roster, join/leave, validated
  options and limits, ready + config messages, `/health`, two-client
  integration tests.
- **S2 — lobby on Colyseus behind a flag (done):** a `VITE_NET_TRANSPORT=colyseus`
  build flag selects a `ColyseusSession` that implements the same surface the
  pages use from `NetSession` (`getPlayers`, `setReady`, `setConfig`,
  `beginMatch`, handlers). PeerJS stays the default. Adds the `start` message,
  reconnection and CORS origin allow-listing.
- **S3A — player movement (done):** bodies in the room state; validated `move`
  protocol (volume, speed, teleport rate); remote players drawn by the existing
  engine through the session's `onRemoteState`/`onPeerGone`.
- **S3B — combat (done):** intents only from clients; server-side hits (map
  walls, hitboxes, lag compensation), damage, health, regen, deaths, respawns,
  scores, winner and rematch; the engine predicts tracers, muzzle flashes and
  sound and shows hit feedback only when the server confirms it.
- **S3C — match outcome (done):** the arena shows the server's `winnerId`
  instead of re-deriving it from the score, and the REMATCH button follows the
  roster's current host (it used the role the tab joined with, so after a host
  migration nobody could start a rematch).
- **S4a — deployment preparation (done):** `server/Dockerfile` (unbuilt: no
  Docker where it was written), the native production start path validated
  locally, a SIGTERM shutdown test, CORS credentials only for allowed origins,
  exact-origin guidance for Vercel previews, `docs/preview-deployment.md`, and
  the Playwright smoke test.
- **S4b — Preview readiness (done):** the `?room=` invite parameter (above),
  an exact deployment checklist and host comparison
  (`preview-deployment.md`), the Windows ↔ macOS acceptance checklist
  (`acceptance-checklist.md`), and a browser test of an old `?code=` link plus
  a guest reload resuming the same seat.
- **S4c — hosted-preview preparation (done locally; hosting pending):**
  `render.yaml` Blueprint (build needs `npm ci --include=dev`: Render sets
  `NODE_ENV=production` during the build), `npm run check:hosted` for a
  deployed server, Node 24 verified, a 5 s "waking the match server" hint, a
  persistent CONNECTION LOST screen when the server restarts (it used to be a
  4-second feed line over a dead arena), and room disposal without unhandled
  `allowReconnection` rejections. Not done: the deployment itself, the
  Preview variables, the Docker build, and the cross-device test.
- **S4 — hosting:** pick a host for the Node service, set up a staging deploy
  and a Vercel preview pointing at it.
- **S5 — retirement:** remove PeerJS, the TURN endpoint and the signaling code
  once Colyseus is the default and verified in production.
