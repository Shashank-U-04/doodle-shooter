// This process's identity and its shutdown diagnostics.
//
// Two restarts on the Render service (2026-11-02) ended with players told
// nothing for 90-127 s, and the logs could not say why: the server wrote nothing
// when it shut down. Each step now logs one JSON line, so the next restart shows
// whether SIGTERM arrived, when, and who was still connected when it did. Session
// ids and room codes only: no names, addresses or tokens.
import { randomUUID } from "crypto";

/**
 * Random per process, and public (/health and every room's state carry it). A
 * client that holds the id of the process it joined can tell, by asking /health
 * after losing its socket, whether that process is gone. Rooms live in one
 * process's memory, so a different id means every room has gone with it.
 */
export const INSTANCE_ID = randomUUID().replace(/-/g, "").slice(0, 16);

/**
 * How long a room waits between telling its players the server is going away and
 * closing their sockets, so the notice is not racing the close. Well inside
 * Render's default 30 s between SIGTERM and SIGKILL.
 */
export const NOTICE_GRACE_MS = 1000;

/** If an orderly shutdown has not finished by now, stop waiting and exit. */
export const SHUTDOWN_BACKSTOP_MS = 15_000;

export function logLifecycle(stage: string, details: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({
      event: "lifecycle",
      stage,
      instance: INSTANCE_ID,
      pid: process.pid,
      uptimeS: Math.round(process.uptime()),
      at: new Date().toISOString(),
      ...details,
    }),
  );
}

let installed = false;

/**
 * Log the boot, every shutdown signal and the exit. Colyseus runs the shutdown
 * itself (registerGracefulShutdown, `process.once`); this only watches, and
 * bounds it. Because this listener stays attached, a repeated signal no longer
 * kills the process mid-shutdown: it is logged and ignored, and the backstop
 * still ends the process.
 */
export function installProcessLifecycle() {
  if (installed) return;
  installed = true;
  logLifecycle("boot", {
    ppid: process.ppid,
    node: process.version,
    commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
  });
  let signals = 0;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      signals++;
      logLifecycle("signal-received", { signal, count: signals });
      if (signals > 1) return;
      setTimeout(() => {
        logLifecycle("shutdown-backstop", { afterMs: SHUTDOWN_BACKSTOP_MS });
        process.exit(0);
      }, SHUTDOWN_BACKSTOP_MS).unref();
    });
  }
  process.on("exit", (code) => logLifecycle("process-exit", { code }));
}
