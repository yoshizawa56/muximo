#!/usr/bin/env bun
import { runMuximod } from "./entrypoint.js";
import { readMuximodBootstrap } from "./launch.js";

try {
  await runMuximod(readMuximodBootstrap());
} catch {
  // runMuximod records startup and shutdown failures through the daemon
  // logger. Keep the private process failure quiet so its client can present a
  // stable, non-internal error message.
  process.exitCode = 1;
}
