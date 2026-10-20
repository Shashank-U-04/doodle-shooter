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
the frontend. Any coturn-compatible relay that supports the TURN REST shared
secret (`use-auth-secret`) works — a self-hosted coturn, or a managed relay that
hands you a shared secret. Providers that only issue an API key (Cloudflare
Realtime TURN, Metered) are still usable through `VITE_TURN_CREDENTIALS_URL`.

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

### The studio theme

The chrome around the game uses a **Studio theme** — gallery-clean, warm off-whites, thin framing, muted neutrals, careful spacing, soft editorial presentation. The game itself renders as pencil-and-ink on paper: outlines, hatching, toon shading, and a scribble vignette when hurt.

---

## Tech Stack

- **Vite + React 19 + TypeScript** — app shell and routing
- **Three.js** — custom hand-drawn rendering engine (`src/game/`)
- **PeerJS / WebRTC** — peer-to-peer online play (data channels, no game server)
- **Tailwind CSS v4 + shadcn/ui** — Studio-themed UI (dashboard, auth, landing chrome)
- **Convex + Convex Auth** — backend & database (email OTP + guest sign-in)
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
│   ├── Game.tsx     # In-game HUD, pause, game over
│   ├── Dashboard.tsx# Signed-in stats page
│   └── Auth.tsx     # Email OTP / guest sign-in
├── components/      # shadcn/ui + app components
└── convex/          # Convex backend (auth, users)
```

## Getting Started

```bash
# install dependencies
bun install

# start the dev server (Convex dev runs alongside in the Freebuff sandbox)
bun run dev
```

The app expects `VITE_CONVEX_URL` and a Convex deployment (see [Environment](#environment)).

## Environment

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_CONVEX_URL` | Client | Convex backend URL used by the React client |
| `CONVEX_DEPLOYMENT` | Client env | Ties the client to a specific Convex deployment |
| `VITE_CONVEX_SITE_URL` | Client | Convex HTTP-actions origin (`https://<deployment>.convex.site`), where `/turn` mints relay credentials. Derived from `VITE_CONVEX_URL` if omitted |
| `TURN_URLS` | Convex dashboard | Relay URLs, comma separated. Include a `turns:` entry on port 443 |
| `TURN_SECRET` | Convex dashboard | Relay shared secret used to mint ephemeral credentials. Server-side only |
| `TURN_TTL`, `TURN_ALLOWED_ORIGINS` | Convex dashboard | Optional credential lifetime (seconds) and origin allow-list |
| `VITE_NET_DEBUG` | Client | `1` enables verbose ICE diagnostics in production builds |
| `VITE_TURN_CREDENTIALS_URL` | Client | Optional third-party ICE-service endpoint, checked before the built-in one |
| `VITE_TURN_URLS` | Client | Static fallback: comma-separated `turn:` / `turns:` relay URLs |
| `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | Client | Credentials for `VITE_TURN_URLS` (visible to clients — prefer the server-side setup) |
| `JWKS`, `JWT_PRIVATE_KEY`, `SITE_URL` | Convex dashboard | Convex Auth signing material |

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
4. Add the Environment Variables from the table above (`VITE_CONVEX_URL` is required, `VITE_CONVEX_SITE_URL` is strongly recommended so online play can reach the relay endpoint).
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
curl -s https://<deployment>.convex.site/turn
# { "configured": true, "iceServers": [ … ], "ttl": 3600, "expiresAt": … }
# or { "configured": false, "reason": "TURN_URLS is not set …" }
```

A `configured: false` answer is exactly what the game shows the player when a
match cannot find a direct route.

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
