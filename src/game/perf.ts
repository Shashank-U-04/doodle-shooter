// A frame-time probe for benchmarking, on only with `?perf=1` in the URL.
//
// Normal play never creates one, so it costs nothing. When on, the engine
// reports every frame here and turns the camera slowly, so each run samples
// the same views. `window.__ddPerf` exposes reset() and summary() to
// scripts/bench.mjs (or a person in the console).
//
// What it measures, per frame:
// - the interval between animation frames (what the player sees as smoothness);
// - CPU time of the engine's step, which includes submitting both render
//   passes (scene and paper post-process) to the GPU. GPU execution time is
//   not measured here: browsers only expose it through an optional timer-query
//   extension;
// - draw calls and triangles summed over both passes.

import type * as THREE from "three";

export type PerfSummary = {
  map: string;
  frames: number;
  seconds: number;
  fpsMean: number;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  frameMsMax: number;
  /** frames slower than 33.3 ms (under 30 fps): where the engine's dt cap starts slowing the simulation */
  framesOver33Ms: number;
  cpuMsP50: number;
  cpuMsP95: number;
  drawCallsP50: number;
  drawCallsMax: number;
  trianglesP50: number;
  trianglesMax: number;
  /** ms from navigation start to the first rendered frame */
  firstFrameMs: number;
  /** Chromium only (performance.memory); null elsewhere */
  heapMb: number | null;
  devicePixelRatio: number;
  drawingBuffer: string;
  gpu: string;
};

type Sample = { frameMs: number; cpuMs: number; calls: number; triangles: number };

const pct = (sorted: number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const r2 = (n: number) => Math.round(n * 100) / 100;

export function perfRequested(search: string): boolean {
  return new URLSearchParams(search).get("perf") === "1";
}

export class PerfProbe {
  private samples: Sample[] = [];
  private last = 0;
  private started = 0;
  private firstFrameMs = 0;
  /** radians a second the camera turns while benchmarking */
  readonly spin = 0.35;
  private renderer: THREE.WebGLRenderer;
  private map: string;

  constructor(renderer: THREE.WebGLRenderer, map: string) {
    this.renderer = renderer;
    this.map = map;
    // both passes count, so info is reset per frame rather than per render()
    renderer.info.autoReset = false;
    const w = window as unknown as { __ddPerf?: unknown };
    w.__ddPerf = { reset: () => this.reset(), summary: () => this.summary() };
  }

  reset() {
    this.samples = [];
    this.last = 0;
    this.started = performance.now();
  }

  /** Call before the frame's work. */
  begin() {
    this.renderer.info.reset();
    return performance.now();
  }

  /** Call after the frame's work (`began` from begin()). */
  end(began: number) {
    const now = performance.now();
    if (!this.firstFrameMs) this.firstFrameMs = now;
    if (!this.started) this.started = now;
    const render = this.renderer.info.render;
    if (this.last) this.samples.push({ frameMs: began - this.last, cpuMs: now - began, calls: render.calls, triangles: render.triangles });
    this.last = began;
  }

  summary(): PerfSummary {
    const by = (k: keyof Sample) => this.samples.map((s) => s[k]).sort((a, b) => a - b);
    const frame = by("frameMs");
    const cpu = by("cpuMs");
    const calls = by("calls");
    const tris = by("triangles");
    const seconds = frame.reduce((t, x) => t + x, 0) / 1000;
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      map: this.map,
      frames: frame.length,
      seconds: r2(seconds),
      fpsMean: r2(seconds > 0 ? frame.length / seconds : 0),
      frameMsP50: r2(pct(frame, 0.5)),
      frameMsP95: r2(pct(frame, 0.95)),
      frameMsP99: r2(pct(frame, 0.99)),
      frameMsMax: r2(frame[frame.length - 1] ?? 0),
      framesOver33Ms: frame.filter((x) => x > 1000 / 30).length,
      cpuMsP50: r2(pct(cpu, 0.5)),
      cpuMsP95: r2(pct(cpu, 0.95)),
      drawCallsP50: pct(calls, 0.5),
      drawCallsMax: calls[calls.length - 1] ?? 0,
      trianglesP50: pct(tris, 0.5),
      trianglesMax: tris[tris.length - 1] ?? 0,
      firstFrameMs: Math.round(this.firstFrameMs),
      heapMb: mem ? Math.round(mem.usedJSHeapSize / 2 ** 20) : null,
      devicePixelRatio: window.devicePixelRatio,
      drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      gpu,
    };
  }
}
