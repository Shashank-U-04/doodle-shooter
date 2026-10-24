# Colyseus acceptance test: Windows ↔ macOS, separate networks

Run on a Vercel Preview built with `VITE_NET_TRANSPORT=colyseus` against the
hosted match server ([`preview-deployment.md`](preview-deployment.md)). The
Colyseus transport replaces PeerJS only after every row passes in both
directions (Windows hosting, then macOS hosting).

## Record first

| | Windows (W) | macOS (M) |
|---|---|---|
| OS version | | |
| Browser + version | | |
| Network (e.g. home Wi-Fi / phone hotspot / office) | | |
| Preview URL and commit | | |
| Server host and `/health` uptime at start | | |

The two machines must be on **different networks** (not the same Wi-Fi). Keep
each browser's developer console open; note any red errors with the row
number. Use names that differ (e.g. `WIN`, `MAC`).

## Checks

Do the whole table with W hosting, then again with M hosting.
✓ = as expected, ✗ = not (describe what happened).

| # | Area | Steps | Expected | Run 1 (W hosts) | Run 2 (M hosts) |
|---|---|---|---|---|---|
| 1 | Server | Open `/online`; network tab | Lobby note "the lobby runs on the match server"; a `wss://<server-host>` socket; no PeerJS/TURN requests | | |
| 2 | Create | Host: Setup → friends → create | 4-character code shown within a few seconds; roster shows the host as "· host · ready" | | |
| 3 | Join | Guest: Setup → join with the code | Both rosters show 2 players; guest URL loses `room=` after joining | | |
| 4 | Join errors | Guest: join a made-up code; then a 5th player into a full room (if available) | "No match with code …"; "That match is full …" — no hang | | |
| 5 | Ready | Guest toggles ready twice | Host's roster follows each toggle; ENTER ARENA only enabled while the guest is ready | | |
| 6 | Map/rules | Host changes map and grapple before starting | Guest's lobby follows; the arena uses the host's map | | |
| 7 | Start | Host: ENTER ARENA | Both arenas load the same map; feed shows "COLYSEUS PREVIEW — THE MATCH SERVER REFEREES EVERY SHOT" | | |
| 8 | Movement | Each walks, sprints, jumps, crouches, turns | The other sees smooth movement and facing; no rubber-banding back to old positions | | |
| 9 | Teleports | Focus dash; grapple (if on); on Egyptian maps go through a door | The other sees a snap, not a slide across the map | | |
| 10 | Aiming | Hip-fire and ADS at the other at mid range | Hitmarker only when the shot visibly connects; ADS more accurate | | |
| 11 | Combat | Each weapon once: rifle, shotgun, sniper (head and body), revolver, katana slash, grenade | Victim's health drops by plausible amounts; headshots hit harder; walls stop bullets | | |
| 12 | Health | Take damage, then hide 5 s | Health regenerates after ~4.5 s without damage; both sides agree | | |
| 13 | Death | Eliminate the other | Victim sees ERASED and their own obituary; killer's feed "… ERASED …"; K/D updates on both | | |
| 14 | Respawn | Wait after death | Victim is back after ~3 s at a spawn pad; the other sees them reappear (snap) | | |
| 15 | Scoring | Play several kills each | Both scoreboards identical at all times | | |
| 16 | Win | Reach 15 kills | Winner sees YOU WIN, the other MATCH OVER with the same name and score; gameplay frozen | | |
| 17 | Rematch | Host: REMATCH | Both restart at fresh pads with 0/0 and the overlay gone | | |
| 18 | Reload (lobby) | Guest reloads the lobby | Back in the same seat within a few seconds; host's roster never shows a duplicate | | |
| 19 | Reload (arena) | Guest reloads mid-match | Back in the arena, same score; the host sees one body that snaps back | | |
| 20 | Network drop | Guest turns Wi-Fi off for ~10 s, then on | "CONNECTION DROPPED — RECONNECTING…", then "RECONNECTED"; same seat and score | | |
| 21 | Long drop | Guest offline > 30 s | Seat released; guest sees a clear error and can join again | | |
| 22 | Host leaves | Host: LEAVE MATCH mid-match (3rd player helps but is optional) | Guest stays in the room and becomes host; REMATCH available to them if the match was decided | | |
| 23 | Host leaves after win | Finish a match, then the winner/host leaves | Guest sees "A PLAYER WHO LEFT took it" and a REMATCH button that works | | |
| 24 | Tab switching | Alt-tab / switch tabs for 20 s, return | No disconnect; pause screen only on the switching side; the match continued | | |
| 25 | Legacy link | Guest opens `<preview-origin>/online?code=<CODE>`, joins, then reloads | Joins; after the reload, back in the same seat (no duplicate) | | |
| 26 | Server asleep | After ≥ 15 min with nobody connected (free host spun down), host creates a room | Within ~5 s "WAKING THE MATCH SERVER…"; the room opens within about a minute | | |
| 27 | Server restart | Mid-match, the owner restarts the service in the Render dashboard | Both see CONNECTION LOST — "The match server restarted…"; LEAVE MATCH returns to the menu; a new room works afterwards | | |
| 28 | Other origins | Run `npm run check:hosted` (server README) with the Preview origin | ALL PASSED | | |
| 29 | Errors | Any red console error, error toast or stuck screen during the run | None, or each written down with its row | | |

## Report back

Both tables, the console errors with row numbers, and for any ✗ the time
(with time zone) so it can be matched with the server's logs.
