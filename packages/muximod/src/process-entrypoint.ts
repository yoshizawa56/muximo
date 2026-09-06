#!/usr/bin/env bun
// Keep the private daemon identifiable when Bun runs the source entrypoint.
import type { MuximodLaunchOptions } from "./launch.js";

export async function runMuximodProcess(
  readBootstrap?: () => MuximodLaunchOptions,
  run?: (options: MuximodLaunchOptions) => Promise<void>,
): Promise<void> {
  process.title = "muximod";
  try {
    const bootstrapReader = readBootstrap ?? (await import("./launch.js")).readMuximodBootstrap;
    const runner = run ?? (await import("./entrypoint.js")).runMuximod;
    await runner(bootstrapReader());
  } catch {
    // runMuximod records startup and shutdown failures through the daemon
    // logger. Keep the private process failure quiet so its client can present a
    // stable, non-internal error message.
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runMuximodProcess();
}
