# Performance baseline

How to measure the client's frame times, and the first numbers. Keep this
up to date when the renderer, maps or assets change. Compare runs only with
the same settings.

## How to run

```sh
npx vite build && npx vite preview --port 4173      # in one terminal
node scripts/bench.mjs                               # in another
node scripts/bench.mjs --json bench.json --seconds 30
node scripts/bench.mjs --headed                      # a real window (closest to a player)
```

What it does:

- `scripts/bench.mjs` loads each map at `/game?map=…&perf=1`.
- `?perf=1` turns on the engine's probe (`src/game/perf.ts`). Normal play
  never creates it.
- After a warm-up it samples for a fixed time while the camera turns at a
  fixed rate.

What it reports:

- Frame interval percentiles: what smoothness feels like.
- Frames over 33 ms. Below 30 fps the engine's `dt` cap makes the simulation
  run slow.
- CPU time of the engine step, including submitting both render passes.
- Draw calls and triangles over both passes.
- Time from navigation to the first frame.
- JavaScript heap.
- The GPU the browser actually used. **Check it**: a run on SwiftShader (software)
  says nothing about players' performance.

Not measured yet:

- GPU execution time (needs a timer-query extension).
- Combat load (enemies, effects, other players).
- Input-to-photon latency.
- Network smoothness. Remote-player interpolation needs its own harness with
  simulated latency and jitter before it is changed (see
  `colyseus-migration.md`).

## Baseline — 2026-10-24

Machine: the development laptop.

| | |
|---|---|
| GPU | Intel Arc (integrated, 0x7D55), ANGLE Direct3D 11 |
| Browser | Chromium (Playwright), headless |
| Resolution | 1600×900, device pixel ratio 1 |
| State | menu, no enemies |
| Sampling | 15 s per map after 4 s warm-up |
| Build | `feat/perf-benchmark` |

| map | fps | frame p50 | p95 | p99 | max | >33 ms | cpu p50 | cpu p95 | draws | tris | first frame ms | heap MB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| district | 60.01 | 16.8 | 22.1 | 24.8 | 29.5 | 0 | 2.2 | 3.0 | 134 | 42182 | 1181 | 17 |
| valley | 60.02 | 16.6 | 21.7 | 24.7 | 27.7 | 0 | 2.3 | 3.6 | 187 | 70952 | 1085 | 23 |
| sanctuary | 60.02 | 16.6 | 22.5 | 24.5 | 25.4 | 0 | 2.3 | 3.4 | 213 | 33214 | 977 | 36 |
| tomb | 59.87 | 16.6 | 23.7 | 25.6 | 38.3 | 2 | 3.1 | 4.3 | 302 | 70450 | 1046 | 23 |

### What this says

- Every map holds the 60 Hz refresh. CPU per frame is 2–3 ms of a 16.7 ms
  budget, so on this machine the renderer is not the bottleneck in the menu
  state.
- The tomb submits the most draw calls (302), more than twice the district,
  and is the only map with frames over 33 ms. If a map needs work first, it is
  the tomb (batching or merging its props).
- Frame-interval p95 sits around 22 ms, while the p50 is on the 16.7 ms
  refresh. Some frames miss a refresh even with CPU time this low. Headless
  timing may cause part of that. Re-measure headed before acting on it.

### Not yet measured

Measure these before setting targets:

- a high-DPR laptop screen;
- a discrete GPU;
- macOS (Safari and Chrome);
- a real match with combat;
- a low-end device.

The provisional targets from the architecture review are p95 ≤ 16.7 ms and
p99 ≤ 33 ms on a mid-range laptop.
