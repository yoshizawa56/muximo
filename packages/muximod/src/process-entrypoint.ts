#!/usr/bin/env bun
import { runMuximod } from "./entrypoint.js";
import { readMuximodBootstrap } from "./launch.js";

export async function runMuximodProcess(fd = 3): Promise<number> {
  try {
    await runMuximod(readMuximodBootstrap(fd));
    return 0;
  } catch {
    // runMuximod records startup and shutdown failures through the daemon
    // logger. Keep the private process failure quiet so its client can present a
    // stable, non-internal error message.
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runMuximodProcess();
