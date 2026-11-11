// Telling a server restart apart from a network problem, after the socket is lost.
//
// A dead socket says nothing about why: close code 1006 is what both a dropped
// Wi-Fi link and a replaced server look like, and counting failed reconnection
// attempts proves nothing either. What does prove a restart is the server itself:
// /health names the process answering, and every room's state names the process
// that holds it. Rooms live in one process's memory, so if a *different* process
// answers, the room is gone.
//
// Only a clear answer naming another process counts. No answer, a refused or
// malformed one, or one from a server too old to name itself is no evidence of
// anything, and the SDK simply goes on reconnecting.

export type InstanceProbe = "same" | "changed" | "no-evidence";

/** How long one /health question may take. */
const PROBE_TIMEOUT_MS = 3000;
/** Pause between questions while reconnecting. */
export const RESTART_PROBE_EVERY_MS = 2000;

/** Ask `url`'s /health whether `known` is still the process serving it. */
export async function probeServerInstance(url: string, known: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<InstanceProbe> {
  try {
    const res = await fetch(`${url.replace(/^ws/i, "http").replace(/\/+$/, "")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "no-evidence";
    const body = (await res.json()) as { status?: unknown; instance?: unknown } | null;
    if (body?.status !== "ok" || typeof body.instance !== "string" || !body.instance) return "no-evidence";
    return body.instance === known ? "same" : "changed";
  } catch {
    return "no-evidence"; // offline, refused, timed out, or not JSON (a captive portal's page)
  }
}

/**
 * Repeats a probe, one at a time, until it reports a change or `stop()` is
 * called. `onChanged` fires at most once per watch.
 */
export class RestartWatch {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly probe: () => Promise<InstanceProbe>;
  private readonly onChanged: () => void;
  private readonly everyMs: number;

  constructor(probe: () => Promise<InstanceProbe>, onChanged: () => void, everyMs = RESTART_PROBE_EVERY_MS) {
    this.probe = probe;
    this.onChanged = onChanged;
    this.everyMs = everyMs;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick() {
    const result = await this.probe();
    if (!this.running) return;
    if (result === "changed") {
      this.stop();
      this.onChanged();
      return;
    }
    this.timer = globalThis.setTimeout(() => void this.tick(), this.everyMs);
  }
}
