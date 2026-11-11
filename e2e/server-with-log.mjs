// Starts the match server for the browser tests (see playwright.config.ts) and
// keeps a copy of everything it prints in $E2E_SERVER_LOG, each line stamped
// with the wall-clock time so it lines up with the browser console the test
// fixture captures (e2e/fixtures.ts). Test-only: production starts the server
// with `node build/index.js` and never runs this.
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const logPath = process.env.E2E_SERVER_LOG;
if (!logPath) throw new Error("E2E_SERVER_LOG is not set");
mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: "a" });

const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { stdio: ["ignore", "pipe", "pipe"], env: process.env });

/** Copy a stream to `out` as is, and to the log a whole line at a time, time-stamped. */
function tee(from, out, tag) {
  let partial = "";
  from.on("data", (chunk) => {
    out.write(chunk);
    const lines = (partial + chunk.toString("utf8")).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) log.write(`${new Date().toISOString()} ${tag} ${line}\n`);
  });
  from.on("end", () => partial && log.write(`${new Date().toISOString()} ${tag} ${partial}\n`));
}
tee(child.stdout, process.stdout, "out");
tee(child.stderr, process.stderr, "err");

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  log.end(`${new Date().toISOString()} --- server exited (code ${code}, signal ${signal})\n`, () => process.exit(code ?? 1));
});
