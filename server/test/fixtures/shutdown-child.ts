// The real server entry point (src/index.ts), plus one test hook: on Windows a
// child process cannot be sent a catchable SIGTERM (Node's kill() terminates it
// outright), so the test asks over IPC and this raises the same signal event
// inside the process. Colyseus' own handler (registerGracefulShutdown) runs
// either way. On POSIX the test sends a real SIGTERM and this hook is unused.
process.on("message", (message) => {
  if (message === "SIGTERM") process.emit("SIGTERM", "SIGTERM");
});

await import("../../src/index.js");
