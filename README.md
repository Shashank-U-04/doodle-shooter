# Doodle Shooter

A hand-drawn survival shooter built from the ground up with Vite, React, TypeScript, a custom Three.js engine, and a warm Studio-theme presentation.

Play it: **START → survive the waves.** Best score is saved locally.

---

## The Game

You are a hand-drawn survivor in a doodled district. Waves of sketched enemies close in from every street, and each wave ends with more of them, faster ones, and — every fifth wave — a named boss (**THE DOODLER**, **THE ERASER**, **THE INKBLOT**).

### Core mechanics

| System | How it works |
| --- | --- |
| **Waves** | Clear every enemy to advance. Every 5th wave spawns a boss with a health bar and a checkpoint. |
| **Score & combo** | Kills build a combo meter that decays quickly — chain kills for score multipliers. Airborne kills pay +33%. |
| **Weapons** | 5 slots, switch with `1–5` or mouse wheel: **Rifle · Shotgun · Sniper · Katana · Revolver**. |
| **Katana** | Hold `F` to slash; three clean kills fill the Focus meter for a heavy strike. |
| **Grenades** | `G` throws an ink grenade. Finite per run. |
| **Movement** | WASD to move, `Space` to jump (double-jump supported), `Shift` sprint, `C`/`Ctrl` crouch, `X` dash. |
| **Grapple** | Hold `Q` / `E` to reel toward points; release to let go. |
| **Mouse look** | Pointer Lock with adjustable sensitivity (`25%–250%`) and optional inverted Y — configured on the title screen. |
| **Pause** | `P` or `Esc` pauses; the menu hands the OS cursor back. |

### The studio theme

The chrome around the game uses a **Studio theme** — gallery-clean, warm off-whites, thin framing, muted neutrals, careful spacing, soft editorial presentation. The game itself renders as pencil-and-ink on paper: outlines, hatching, toon shading, and a scribble vignette when hurt.

---

## Tech Stack

- **Vite + React 19 + TypeScript** — app shell and routing
- **Three.js** — custom hand-drawn rendering engine (`src/game/`)
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
│   ├── rig.ts       # Doodle character models (sphere-and-tube people)
│   ├── shaders.ts   # Pencil/ink shaders, vignette effects
│   ├── weapons.ts   # Weapon definitions and firing logic
│   └── audio.ts     # Procedural SFX + music
├── pages/
│   ├── Landing.tsx  # Title screen — START, settings, controls
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
4. Add the Environment Variables from the table above (`VITE_CONVEX_URL` is required).
5. **Deploy.** Every push to `main` now ships a new build automatically.

### Backend (Convex production)

The dev deployment used in the sandbox is separate from production:

```bash
npx convex prod  # or: npx convex deploy --prod
```

Then point the Vercel `VITE_CONVEX_URL` at the **production** deployment URL from `npx convex dashboard`.

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

## License

MIT — see [LICENSE](LICENSE).
