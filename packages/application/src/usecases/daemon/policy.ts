import type { DaemonClock, DaemonProcessHandle, DaemonRuntimePort, DaemonScheduler } from "../../ports/daemon.js";

export type DaemonLifecycleDependencies = {
  runtime: DaemonRuntimePort;
  clock: DaemonClock;
  scheduler: DaemonScheduler;
  lifecycleTimeoutMs: number;
};

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timing: Pick<DaemonLifecycleDependencies, "clock" | "scheduler">,
): Promise<boolean> {
  const pollIntervalMs = 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("daemon wait timeout must be non-negative");
  const deadline = timing.clock.now() + timeoutMs;
  while (true) {
    if (await condition()) return true;
    const remainingMs = deadline - timing.clock.now();
    if (remainingMs <= 0) return false;
    await timing.scheduler.sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

export function terminateQuietly(child: DaemonProcessHandle): void {
  try {
    child.terminate("SIGTERM");
  } catch {
    // The child may have exited already; preserve the useful health error.
  }
}
