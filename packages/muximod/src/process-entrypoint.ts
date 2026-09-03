#!/usr/bin/env bun
// Keep the private daemon identifiable when Bun runs the source entrypoint.
process.title = "muximod";

const { runMuximod } = await import("./entrypoint.js");
const { readMuximodBootstrap } = await import("./launch.js");

try {
  await runMuximod(readMuximodBootstrap());
} catch {
  // runMuximod records startup and shutdown failures through the daemon
  // logger. Keep the private process failure quiet so its client can present a
  // stable, non-internal error message.
  process.exitCode = 1;
}
