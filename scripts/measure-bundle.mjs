// What a first page load downloads before any route-specific chunk: the entry
// module, everything index.html preloads, any inline scripts, and the CSS.
// Also totals every JavaScript asset, for comparing builds.
//
// Usage: node scripts/measure-bundle.mjs [distDir] [--json]
// Prints a Markdown table (CI appends it to the job summary).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const json = args.includes("--json");
const dist = args.find((a) => !a.startsWith("--")) ?? "dist";
const html = readFileSync(join(dist, "index.html"), "utf8");

const sizes = (buf) => ({ raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length });
const asset = (href) => {
  const file = join(dist, href.replace(/^\//, ""));
  return { name: href, ...sizes(readFileSync(file)) };
};

const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]+)"`))?.[1];
const tags = (re) => [...html.matchAll(re)].map((m) => m[0]);

const entry = tags(/<script[^>]*\bsrc="[^"]+"[^>]*>/g).map((t) => asset(attr(t, "src")));
const preloads = tags(/<link[^>]*rel="modulepreload"[^>]*>/g).map((t) => asset(attr(t, "href")));
const css = tags(/<link[^>]*rel="stylesheet"[^>]*>/g)
  .map((t) => attr(t, "href"))
  .filter((h) => h && !/^https?:/.test(h))
  .map(asset);
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1].trim())
  .filter(Boolean)
  .map((body, i) => ({ name: `(inline script ${i + 1})`, ...sizes(Buffer.from(body)) }));
const external = tags(/<(?:script|link)[^>]*(?:src|href)="https?:\/\/[^"]+"[^>]*>/g).map((t) => attr(t, "src") ?? attr(t, "href"));

const assetsDir = join(dist, "assets");
const allJs = readdirSync(assetsDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ name: f, ...sizes(readFileSync(join(assetsDir, f))) }));

const sum = (list) => list.reduce((t, x) => ({ raw: t.raw + x.raw, gzip: t.gzip + x.gzip }), { raw: 0, gzip: 0 });
const initialJs = [...entry, ...preloads, ...inline];
const report = {
  dist,
  builtAt: statSync(join(dist, "index.html")).mtime.toISOString(),
  initialJs: { files: initialJs, total: sum(initialJs) },
  initialCss: { files: css, total: sum(css) },
  allJs: { count: allJs.length, total: sum(allJs) },
  largestJs: [...allJs].sort((a, b) => b.gzip - a.gzip).slice(0, 8),
  externalUrls: external,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const row = (f) => `| ${f.name} | ${kb(f.raw)} | ${kb(f.gzip)} |`;
  console.log(`### Bundle (${dist})\n`);
  console.log("| Initial load | raw | gzip |\n|---|---:|---:|");
  for (const f of [...initialJs, ...css]) console.log(row(f));
  console.log(row({ name: "**initial JS total**", ...report.initialJs.total }));
  console.log(row({ name: `**all JS (${allJs.length} files)**`, ...report.allJs.total }));
  console.log("\n| Largest JS chunks | raw | gzip |\n|---|---:|---:|");
  for (const f of report.largestJs) console.log(row(f));
  if (external.length) console.log(`\nExternal URLs referenced by index.html: ${external.join(", ")}`);
}
