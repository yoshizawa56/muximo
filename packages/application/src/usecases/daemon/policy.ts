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
  const deadline = timing.clock.now() + timeoutMs;
  while (timing.clock.now() < deadline) {
    if (await condition()) return true;
    await timing.scheduler.sleep(50);
  }
  return condition();
}

export function terminateQuietly(child: DaemonProcessHandle): void {
  try {
    child.terminate("SIGTERM");
  } catch {
    // The child may have exited already; preserve the useful health error.
  }
}
