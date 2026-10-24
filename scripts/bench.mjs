// Frame-time benchmark for every map, through the engine's ?perf=1 probe
// (src/game/perf.ts).
//
//   npx vite build && npx vite preview --port 4173 &
//   node scripts/bench.mjs [--url http://127.0.0.1:4173] [--maps district,valley]
//                          [--seconds 20] [--warmup 4] [--size 1600x900]
//                          [--gpu hardware|software] [--headed] [--json out.json]
//
// --gpu hardware (default) asks headless Chromium to render on this machine's
// GPU through ANGLE; check the reported `gpu` column, because a browser that
// cannot get the GPU falls back to software and its numbers are meaningless
// for players. --gpu software forces SwiftShader (what CI has: it proves the
// harness works, not how fast the game is). --headed opens a real window.
//
// Each map: load /game?map=…&perf=1, let it warm up, then sample. The camera
// turns at a fixed rate in the menu state, so runs are comparable; no enemies
// are fighting (that is a separate, gameplay benchmark).
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const url = opt("url", "http://127.0.0.1:4173").replace(/\/+$/, "");
const maps = opt("maps", "district,valley,sanctuary,tomb").split(",");
const seconds = Number(opt("seconds", "20"));
const warmup = Number(opt("warmup", "4"));
const [width, height] = opt("size", "1600x900").split("x").map(Number);
const gpu = opt("gpu", "hardware");
const jsonOut = opt("json", "");

const gpuArgs =
  gpu === "software"
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "win32" ? ["--use-angle=d3d11"] : [])];

const browser = await chromium.launch({ headless: !flag("headed"), args: gpuArgs });
const results = [];
try {
  for (const map of maps) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${url}/game?map=${map}&grapple=1&perf=1`);
    await page.waitForFunction(() => window.__ddPerf !== undefined, null, { timeout: 60_000 });
    await page.waitForTimeout(warmup * 1000);
    await page.evaluate(() => window.__ddPerf.reset());
    await page.waitForTimeout(seconds * 1000);
    const summary = await page.evaluate(() => window.__ddPerf.summary());
    results.push({ ...summary, pageErrors: errors.length });
    await page.close();
    process.stderr.write(`${map}: ${summary.fpsMean} fps mean, p95 ${summary.frameMsP95} ms\n`);
  }
} finally {
  await browser.close();
}

const cols = [
  ["map", "map"],
  ["fps", "fpsMean"],
  ["frame p50", "frameMsP50"],
  ["p95", "frameMsP95"],
  ["p99", "frameMsP99"],
  ["max", "frameMsMax"],
  [">33 ms", "framesOver33Ms"],
  ["cpu p50", "cpuMsP50"],
  ["cpu p95", "cpuMsP95"],
  ["draws", "drawCallsP50"],
  ["tris", "trianglesP50"],
  ["first frame ms", "firstFrameMs"],
  ["heap MB", "heapMb"],
];
console.log(`### Frame times (${seconds}s per map after ${warmup}s warm-up, ${width}x${height}, gpu mode ${gpu})\n`);
console.log(`GPU: ${results[0]?.gpu ?? "?"} · DPR ${results[0]?.devicePixelRatio ?? "?"} · buffer ${results[0]?.drawingBuffer ?? "?"}\n`);
console.log(`| ${cols.map(([h]) => h).join(" | ")} |`);
console.log(`|${cols.map(() => "---").join("|")}|`);
for (const r of results) console.log(`| ${cols.map(([, k]) => r[k] ?? "–").join(" | ")} |`);
if (results.some((r) => r.pageErrors)) console.log("\nPage errors occurred; see stderr.");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ when: new Date().toISOString(), url, seconds, warmup, width, height, gpu, results }, null, 2));
