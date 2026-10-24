# Doodle Shooter

A hand-drawn survival shooter built from the ground up with Vite, React, TypeScript, a custom Three.js engine, and a warm Studio-theme presentation.

**START** → survive the waves. **PLAY ONLINE** → share a code and shoot a friend.
Best score is saved locally.

---

## The Game

You are a hand-drawn survivor in a doodled district. Waves of sketched enemies close in from every street, and each wave ends with more of them, faster ones, and — every fifth wave — a named boss (**THE DOODLER**, **THE ERASER**, **THE INKBLOT**).

### Core mechanics

| System | How it works |
| --- | --- |
| **Waves** | Clear every enemy to advance. Every 5th wave spawns a boss with a health bar and a checkpoint. |
| **Score & combo** | Kills build a combo meter that decays quickly — chain kills for score multipliers. Airborne kills pay +33%. |
| **Weapons** | 5 slots, switch with `1–5` or mouse wheel: **Rifle · Shotgun · Sniper · Katana · Revolver**. |
| **Katana** | Left-click slashes a forward cone (~3 m) — no ammo, no tracers, no muzzle flash, and the blade carves a single diagonal across the view (raised over the left shoulder, down past the right hip) instead of kicking back like a gun. Landed slashes and folded rounds fill the Focus meter; a full meter makes `F` a dash-and-strike. |
| **Grenades** | `G` throws an ink grenade. Finite per run. |
| **Movement** | WASD to move, `Space` to jump (double-jump supported), `Shift` sprint, `C`/`Ctrl` crouch, `X` dash. |
| **Grapple** | Hold `Q` / `E` to reel toward points; release to let go. |
| **Mouse look** | Pointer Lock with adjustable sensitivity (`25%–250%`) and optional inverted Y — configured on the title screen. |
| **Pause** | `P` or `Esc` pauses; the menu hands the OS cursor back. |

### Ancient Egypt — The Pharaoh's Valley

`ENTER THE VALLEY` on the title screen loads a second, fully explorable map on
the same engine. It is built from modular ink geometry (no backdrop image) and
is split into **three connected areas** with their own colliders, spawn pads and
palette — the other two are hidden while you are in one, so the tomb costs
nothing while you cross the dunes.

| Area | What is there |
| --- | --- |
| **The Pharaoh's Valley** (surface) | The great pyramid and two enterable smaller pyramids, a colonnaded temple with a hidden alcove, a sphinx, obelisks, Anubis statues, broken ruins, market tents with wooden crates, an abandoned camp, treasure chests, palm trees, cacti, a small oasis, dunes, cracked ground and a dry canyon cut into the western cliffs. No coastline, no sea. |
| **The Forgotten Sanctuary** (pyramid interior) | A low processional corridor into a carved sandstone chamber with columns, hieroglyph walls, torchlight, a side chapel, an armed floor-spike trap, pharaoh statues and the concealed dais hatch that leads down. |
| **The Cursed Tomb** (underground) | Burial chambers, a treasure vault, a pharaoh's room and a secret vault; sealed stone doors, sarcophagi, a pressure plate, spike pits, levers, a hidden wall, gold hoards and wandering mummies. |

- **Doors and objects.** Press **`H`** near a door, chest, sarcophagus, lever or
  hatch. Stone doors physically slide open — most sink into the sand or the
  floor, the sanctuary door retracts into its wall — and the collider drops once
  the slab has cleared, so you walk through the gap; exits, hatch descents and
  the return stair keep your health, ammo, grenades and score exactly as they
  were.
- **Mummies.** Wrapped guardians patrol their crypt until they see you (or are
  shot), then rise, shamble, lunge and swing. They use the existing enemy rig,
  wave, damage and loot systems — killing one can drop ammo or health.
- **Traps.** The tomb's pressure plate opens the sealed gate and arms the burial
  spikes; the north corridor's spike pit is live from the start. Spike hits have
  a short cooldown so standing in a pit drains, rather than deletes, a run.
- **Waves still run.** Egypt uses the same wave survival loop; underground the
  roster swaps to mummies and drops the open-air snipers and paper wasps.

### Online deathmatch (free for all)

`PLAY ONLINE` on the title screen opens the lobby. One player **creates a
match** and gets a 4-letter code; the others **join** with that code; the host
starts it and up to **four players** drop into the district. First to 15 kills
takes the match, and the host can call a rematch from the results screen —
scores reset on every client, and everyone is put back on a fresh spawn corner.

- **Peer-to-peer over WebRTC.** Every other player is drawn into the same map as
a real doodle with their own ink colour, walk cycle and weapon — no game server
sits in the middle, so the browsers talk directly (PeerJS is used only for the
first handshake that introduces them). The host multiplexes: every body in the
lobby is folded into a single snapshot packet per guest per tick, so four
players cost three packets out rather than nine.
- **Split authority.** Each client owns its own body: it moves, shoots, and
decides when it is down. A hit is decided by the shooter — the ray is tested
against the body the packet drew, led by half the round trip — and then
*validated* by the victim, who rewinds to where they actually were when the shot
was fired and allows a little slack for the mesh disagreement that always exists
between four connections. Deaths are announced to the district, so every client
builds the same scoreboard and agrees on the winner.
- **Down, not out.** A death is a ~3 second wait; you respawn at the point
furthest from the other doodles. Health regenerates out of combat, ammo comes
from the pickups scattered around the district.
- **Player count.** Four, and a fifth is refused with "match full". The star
through the host is what keeps a match serverless; it is not a mesh, and the
packet budget is what sets the ceiling.

> WebRTC needs a secure context: play over the deployed `https://` URL (or
> `localhost`). The first connection can take a couple of seconds while the two
> browsers negotiate, and each player needs a modern desktop browser.

#### The signaling broker (finding each other)

The broker is **PeerJS**: the host registers `ds-pvp-<CODE>` with it, the guest
asks it for that id, and the two browsers exchange one offer/answer and their
ICE candidates. It is not involved in gameplay. Discovery therefore fails if
the broker is unreachable, even though the match itself would have been
peer-to-peer — and that failure is reported separately from an ICE/TURN failure.

The default broker is the public PeerJS cloud endpoint,
`wss://0.peerjs.com:443/`. The lobby logs the endpoint it is using and shows a
`SIGNALING …` line whenever it is not connected. To use your own broker (for
isolation or because the cloud broker is blocked on a network), set these in
the **frontend** build:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_PEER_HOST` | `0.peerjs.com` | PeerServer hostname |
| `VITE_PEER_PORT` | `443` | port |
| `VITE_PEER_PATH` | `/` | server path (normalised to `/name/`) |
| `VITE_PEER_KEY` | `peerjs` | server key |
| `VITE_PEER_SECURE` | `1` | `0` uses `ws://` (only valid on an `http:` page) |

A self-hosted broker is a small Node `PeerServer` with TLS in front of it. It
must be reachable over **WebSockets**, not just HTTP. A broker on `ws://` cannot
be used from an `https://` game — the browser blocks it as mixed content, which
the app now reports explicitly instead of waiting for a generic timeout.

Signaling recovery is bounded: five attempts at 0.5s/1s/2s/4s/8s, then the
lobby stops and says the broker is unreachable. A hidden tab that becomes
visible again starts one fresh bounded cycle; it never creates a new room, and
it never tears down a data channel that is still carrying a match.

#### Room codes stay put

A room code belongs to the room, not to a render. It is drawn once when the
room is created and stored in this tab's `sessionStorage` (not shared between
tabs). Reloading, returning from bfcache or switching tabs resumes the same
code for up to six hours. `LEAVE ROOM` clears it, so the next `CREATE MATCH` is
the only thing that draws a new code. An expired or deliberately replaced room
is the only other way the code changes.

The lobby's `IN THE ROOM` list is confirmed membership: the host appears only
after the broker accepts the host id, and a guest appears only after the host's
roster lists it. A guest that opened a data channel but was never confirmed is
shown as `JOINING…`, not as a player.

#### Playing across two networks

A direct browser-to-browser route only exists if at least one of you can be
reached — on the same WiFi that is always true, and across the internet it is
true surprisingly often thanks to STUN. Two networks behind **symmetric NAT**
(two separate mobile hotspots, a strict office firewall) have no direct route at
all, and the only fix is a **TURN relay** to carry the traffic. That relay is the
one piece of infrastructure this otherwise serverless game needs.

The relay is configured **on the server**, not in the client bundle. A Convex
HTTP action mints a short-lived credential per match
(`src/convex/turn.ts`, `GET <deployment>.convex.site/turn`), so the relay's
shared secret never ships to the browser and can be rotated without rebuilding
the frontend. The endpoint uses the standard TURN REST scheme
(`username = <unix expiry>:<label>`, `credential = base64(HMAC-SHA1(secret, username))`),
which coturn's `use-auth-secret` accepts.

A provider that instead issues an **API key** and expects you to call its own
API (Cloudflare Realtime/Calls TURN, Metered's dashboard API, Twilio) is not a
TURN REST shared-secret server. Do not put that key in `TURN_SECRET`. Either run
coturn/a provider that supports `use-auth-secret`, or expose a small
server-side proxy that calls the provider and returns `{ iceServers }`, then
point `VITE_TURN_CREDENTIALS_URL` at it. That URL is public to the browser, so
the proxy must be the thing holding the provider key, not the client.

Credentials are cached only until they are about to expire (the endpoint's
`expiresAt`/`ttl`). Expired credentials are re-fetched when a tab becomes
visible while idle, and a relay rejection triggers one refresh-and-retry before
the player is shown an error.

Set these on the **Convex deployment** (dashboard → Settings → Environment
Variables, or `bunx convex env set`):

| Variable | Example | Meaning |
| --- | --- | --- |
| `TURN_URLS` | `turn:relay.example.com:3478,turns:relay.example.com:443?transport=tcp` | The relay's URLs, comma separated. Include a `turns:` entry on 443 — it looks like ordinary HTTPS, which is what gets through a hostile firewall. |
| `TURN_SECRET` | *long random string* | The relay's shared secret (`static-auth-secret` in coturn). Never exposed to the client. |
| `TURN_TTL` | `3600` *(optional)* | Credential lifetime in seconds. Default 3600, capped at 86400. |
| `TURN_ALLOWED_ORIGINS` | `https://yourgame.vercel.app` *(optional)* | Restricts which origins may mint credentials. Unset means any origin, which is fine for a deliberately public relay. |

The client needs `VITE_CONVEX_SITE_URL` (`https://<deployment>.convex.site`) so
it knows where to ask; it is derived from `VITE_CONVEX_URL` when absent.

Still supported, for providers that only hand out a ready-made ICE list:

1. **`VITE_TURN_CREDENTIALS_URL`** — an endpoint returning an `RTCIceServer[]`
   or `{ iceServers }`. Explicit opt-in; it is checked before the built-in
   endpoint.
2. **`VITE_TURN_URLS` + `VITE_TURN_USERNAME` + `VITE_TURN_CREDENTIAL`** — a
   static relay in the client bundle. Only for long-lived credentials, and it
   publishes them to anyone who opens devtools.

With no relay configured the game is STUN-only. The client logs one clear
warning naming the missing server variables, and a failed handshake reports
*why* it failed (no relay configured, relay credentials rejected, relay
unreachable, relay gathered but unable to carry the session) instead of
blaming the player's network. Set `VITE_NET_DEBUG=1` to also log gathering
state, every candidate type, and the selected candidate pair — `net.ts` never
logs a credential or a username.

#### Diagnosing an online failure

The lobby now separates the three layers that used to share one vague message.
Each row below is a different root cause with a different fix; configuring TURN
will not fix a broker that cannot be reached.

| What the lobby shows | Layer | What it means | Where to look |
| --- | --- | --- | --- |
| `SIGNALING RETRYING` / `LOST`, `broker is unreachable` | Broker | The WebSocket to the signaling server failed or was closed and every bounded retry failed. The room code is fine; nobody can discover it. | Broker hostname/port/path, `VITE_PEER_SECURE` vs page protocol, a firewall/proxy that blocks WebSockets, a self-hosted PeerServer behind TLS. |
| `room code is already held` | Broker | Another peer (often an older tab) still owns `ds-pvp-<CODE>`. | `LEAVE ROOM` then create again, which draws a new code. |
| `host is not reachable on the signaling broker` | Broker/room | The broker answered, but no host is registered under that code: the host left, its broker socket dropped, or the code is stale. | Host lobby's `SIGNALING` line; host may need to leave and recreate the room. |
| `no relay is configured` + `TURN_URLS` | TURN config | `/turn` answered `configured: false`. | Set `TURN_URLS` + `TURN_SECRET` on the **Convex** deployment, then curl `/turn`. |
| `relay credential endpoint could not be reached` | TURN/frontend | The browser could not fetch `/turn` (wrong site URL, CORS, endpoint down, or a 4s timeout). | `VITE_CONVEX_SITE_URL`, `TURN_ALLOWED_ORIGINS`, the Convex site deployment. Rebuild Vercel after changing client env. |
| `relay credentials had expired` / `relay rejected its credentials` | TURN credentials | The relay refused the username/credential pair. | `TURN_SECRET` must be the relay's shared secret, `TURN_URLS` its real `turn:`/`turns:` URLs; check the deployment clock. |
| `relay is configured but did not answer` | TURN reachability | No relay candidate was gathered from this network. | UDP may be blocked; include `turns:<host>:443?transport=tcp` and verify the provider allows TURN over TCP/TLS. |
| `relay answered but could not carry the session` | TURN/ICE | A relay candidate existed, but the selected pair still failed. | Provider permissions (data channels), or a broken relay; compare with a different provider/network. |
| `No network route could be gathered` | Browser/network | Even host candidates failed. | Device offline, DNS, or a WebRTC-policy extension/enterprise policy. |

Diagnostics are deliberately safe to paste: the net layer logs the broker
endpoint, relay source and expiry, candidate-type counts, ICE states and the
selected candidate-pair type. It never logs a TURN username/credential, the
shared secret, or a room token. Use `VITE_NET_DEBUG=1` to see per-candidate and
per-connection logging in production builds.

### Colyseus lobby (opt-in preview)

The multiplayer migration to [Colyseus](server/README.md) is in progress (plan:
[docs/colyseus-migration.md](docs/colyseus-migration.md)). **PeerJS remains the
default.** A build with `VITE_NET_TRANSPORT=colyseus` runs the lobby on the match
server instead: the server draws the room code, owns the roster, ready flags,
map and grapple rule, the four-player limit and the decision to start, and holds
a dropped player's seat for 30 seconds so a reload resumes it. In the arena,
players see each other move (the server validates every position, speed and
teleport), and the server referees every shot: hits, damage, health, deaths,
respawns and the score are its call, and a client cannot claim damage.

Try it locally:

```bash
cd server && npm ci && npm start            # match server on :2567
# in the repo root, another terminal:
VITE_NET_TRANSPORT=colyseus bun run dev      # Vite on :5173, an allowed dev origin
```

Open `/online` in two different browsers (or one normal and one private
window — each tab keeps its own seat), create a match in one and join with the
code in the other.

**Fallback:** unset `VITE_NET_TRANSPORT` (or set it to anything but
`colyseus`) and rebuild. Nothing else changes: the PeerJS, TURN and Convex
configuration is untouched by the flag.

### The studio theme

The chrome around the game uses a **Studio theme** — gallery-clean, warm off-whites, thin framing, muted neutrals, careful spacing, soft editorial presentation. The game itself renders as pencil-and-ink on paper: outlines, hatching, toon shading, and a scribble vignette when hurt.

---

## Tech Stack

- **Vite + React 19 + TypeScript** — app shell and routing
- **Three.js** — custom hand-drawn rendering engine (`src/game/`)
- **Colyseus 0.18** — authoritative match server in `server/` (opt-in today via `VITE_NET_TRANSPORT=colyseus`)
- **PeerJS / WebRTC** — legacy peer-to-peer online play, still the default transport
- **Tailwind CSS v4 + shadcn/ui** — Studio-themed UI (landing chrome)
- **Convex** — legacy backend; only its `/turn` route (TURN credentials for PeerJS) is still used. The game starts without it
- **Framer Motion** — page transitions and UI animation

## Project Structure

```
src/
├── game/            # The game engine (no framework, pure Three.js)
│   ├── engine.ts    # Game loop, waves, combat, pointer-lock camera
│   ├── world.ts     # Wave spawning, enemy stats, boss behavior
│   ├── district.ts  # District map builder (streets, buildings, staircases)
│   ├── egypt.ts     # Ancient Egypt map: surface, pyramid interior, tomb
│   ├── rig.ts       # Doodle character models (sphere-and-tube people)
│   ├── shaders.ts   # Pencil/ink shaders, vignette effects
│   ├── weapons.ts   # Weapon definitions and firing logic
│   ├── net.ts       # Online play: rooms, roster, P2P state and hit trading
│   └── audio.ts     # Procedural SFX + music
├── pages/
│   ├── Landing.tsx  # Title screen — START, PLAY ONLINE, settings, controls
│   ├── Online.tsx   # Match lobby + free-for-all arena
│   └── Game.tsx     # In-game HUD, pause, game over
├── components/      # shadcn/ui + app components
└── convex/          # Legacy Convex backend (TURN credentials; unused sign-in tables)
```

## Getting Started

```bash
# install dependencies
bun install

# start the dev server
bun run dev
```

Two package managers, one lockfile each: the frontend (repo root) uses **Bun**
with `bun.lock` (`bun install --frozen-lockfile` reproduces it; Vercel picks Bun
from that lockfile), and the match server uses **npm** with
`server/package-lock.json` (`npm ci`, as Render runs it). Don't add a root
`package-lock.json`: an npm install at the root would ignore `bun.lock`.
The server's test suite also needs the frontend installed (`bun install` at the
root first): its parity tests import the game's own map builders and weapon
tables. The server's production build does not.

Every pull request runs `.github/workflows/ci.yml`: frontend typecheck, lint and
build (with an initial-load bundle report), the server's `npm run check` on
Node 22 and 24, and the Playwright smoke tests.

No environment variables are needed to start the game. Online play over PeerJS
across networks needs the TURN relay settings below; the Colyseus lobby needs
`VITE_NET_TRANSPORT` and `VITE_COLYSEUS_URL`.

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_CONVEX_SITE_URL` | Client | Convex HTTP-actions origin (`https://<deployment>.convex.site`), where `/turn` mints relay credentials for PeerJS. Set it explicitly in Vercel |
| `VITE_CONVEX_URL` | Client | Only read to derive `VITE_CONVEX_SITE_URL` when that is unset. Nothing else in the client uses Convex |
| `CONVEX_DEPLOYMENT` | Local env | Ties `npx convex` commands to a deployment |
| `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_KEY`, `VITE_PEER_SECURE` | Client | Optional self-hosted signaling broker. Unset means the public PeerJS cloud broker |
| `TURN_URLS` | Convex dashboard | Relay URLs, comma separated. Include a `turns:` entry on port 443 |
| `TURN_SECRET` | Convex dashboard | Relay shared secret used to mint ephemeral credentials. Server-side only |
| `TURN_TTL`, `TURN_ALLOWED_ORIGINS` | Convex dashboard | Optional credential lifetime (seconds) and origin allow-list |
| `VITE_NET_DEBUG` | Client | `1` enables verbose ICE diagnostics in production builds |
| `VITE_NET_TRANSPORT` | Client | `colyseus` opts the online lobby into the Colyseus match server. Unset (or anything else) keeps PeerJS |
| `VITE_COLYSEUS_URL` | Client | Match server URL for `VITE_NET_TRANSPORT=colyseus`. Development builds default to `http://localhost:2567`; production builds need it set |
| `VITE_TURN_CREDENTIALS_URL` | Client | Optional third-party ICE-service endpoint, checked before the built-in one |
| `VITE_TURN_URLS` | Client | Static fallback: comma-separated `turn:` / `turns:` relay URLs |
| `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | Client | Credentials for `VITE_TURN_URLS` (visible to clients — prefer the server-side setup) |
| `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL` | Convex dashboard | Convex Auth signing material (the sign-in pages were removed; the backend still defines the provider) |

Never commit `.env` files — set client env in your host's dashboard, and backend env in the Convex dashboard (`npx convex env set`).

## Deployment

### Frontend (Vercel)

This is a single-page app — client-side routing needs a rewrite rule so deep links like `/game` don't 404. A `vercel.json` is included:

```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
```

1. Push the repo to GitHub (already connected).
2. In Vercel: **Add New → Project → Import** the repo.
3. Framework preset **Vite**. Build command `bun run build` (or `npm run build`), output dir `dist`.
4. Add the Environment Variables from the table above. None is required for the game to start; `VITE_CONVEX_SITE_URL` (or `VITE_CONVEX_URL`) lets PeerJS online play reach the relay endpoint.
5. **Deploy.** Every push to `main` now ships a new build automatically.

### Backend (Convex production)

The dev deployment used in the sandbox is separate from production:

```bash
npx convex prod  # or: npx convex deploy --prod
```

Then point the Vercel `VITE_CONVEX_URL` at the **production** deployment URL from `npx convex dashboard`.

Online play across restrictive networks needs a relay, set on the production
deployment — no frontend rebuild and no secret in the bundle:

```bash
npx convex env set TURN_URLS "turn:relay.example.com:3478,turns:relay.example.com:443?transport=tcp"
npx convex env set TURN_SECRET "<the relay's static-auth-secret>"
# optional: npx convex env set TURN_ALLOWED_ORIGINS "https://yourgame.vercel.app"
```

Verify it without a browser:

```bash
# 1. The endpoint itself (no Origin header).
curl -s https://<deployment>.convex.site/turn
# { "configured": true, "iceServers": [ … ], "ttl": 3600, "expiresAt": … }
# or { "configured": false, "reason": "TURN_URLS is not set …" }

# 2. CORS from the real game origin (the browser sends this Origin).
curl -si -H 'Origin: https://yourgame.vercel.app' https://<deployment>.convex.site/turn \
  | grep -i 'HTTP/\|access-control-allow-origin\|cache-control'
# Expect 200 + Access-Control-Allow-Origin: https://yourgame.vercel.app
# and Cache-Control: no-store. No ACAO header = TURN_ALLOWED_ORIGINS blocks it.

# 3. The signaling broker must accept a WebSocket upgrade from the game host.
#    A 404/200 HTTP answer does not prove WebSockets work through a proxy.
#    In devtools › Network › WS, the lobby connection must stay open.
```

Do not print or paste the TURN credential response into an issue: it contains a
short-lived relay credential. `configured: true` proves the endpoint can mint a
credential, **not** that a relay candidate was gathered. Only a real match that
selects a `relay/…` candidate pair proves the relay works (set
`VITE_NET_DEBUG=1` and look for `TURN relay is carrying this match`).

A `configured: false` answer is exactly what the game shows the player when a
match cannot find a direct route.

### Frontend environment changes need a redeploy

Vite inlines `VITE_*` values at **build** time. Editing them in Vercel does not
change an existing deployment: trigger a new deployment (Redeploy without build
cache) and confirm the bundle was rebuilt. `VITE_CONVEX_SITE_URL` missing from
the build is reported by the lobby as *“this build has no Convex site URL”*,
which is a different failure from a deployed `/turn` returning
`configured: false`.

### Custom domain

In Vercel → Project → **Settings → Domains**, add your domain and follow the DNS instructions.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | Vite dev server |
| `bun run build` | Typecheck + production build to `dist/` |
| `bun run preview` | Serve the production build locally |
| `bun run lint` | ESLint |
| `bun run format` | Prettier |
| `bun scripts/check-net.ts` | Headless online-play checks: TURN credential format, URL parsing, ICE filtering/failure classes, signaling retry/classification, TURN CORS, room-lease stability |

## Controls Reference

| Key | Action |
| --- | --- |
| `WASD` | Move |
| Mouse | Look (pointer lock; sensitivity on the title screen) |
| `LMB` / `RMB` | Fire / aim down sights (block with katana) |
| `Space` | Jump · again in air = double jump |
| `Shift` | Sprint |
| `C` / `Ctrl` | Crouch |
| `X` | Dash |
| `Q` / `E` | Grapple (hold to reel in, release to let go) |
| `F` | Katana slash |
| `R` | Reload |
| `G` | Grenade |
| `1–5` / wheel | Weapon slots |
| `M` | Music toggle |
| `P` / `Esc` | Pause |
| `H` | Interact — doors, chests, sarcophagi, levers (Ancient Egypt) |

## License

MIT — see [LICENSE](LICENSE).
