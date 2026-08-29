import type { ProcessResult } from "../../ports/agent-sessions.js";
import type { DaemonClock, DaemonProcessHandle, DaemonRuntimePort, DaemonScheduler } from "../../ports/daemon.js";

export type DaemonLifecycleDependencies = {
  runtime: DaemonRuntimePort;
  clock: DaemonClock;
  scheduler: DaemonScheduler;
  lifecycleTimeoutMs: number;
};

export type DaemonStartupWaitResult =
  | { kind: "healthy" }
  | { kind: "exited"; process: ProcessResult }
  | { kind: "timeout" };

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

export async function waitForHealthyOrExit(
  condition: () => boolean | Promise<boolean>,
  child: DaemonProcessHandle,
  timeoutMs: number,
  timing: Pick<DaemonLifecycleDependencies, "clock" | "scheduler">,
): Promise<DaemonStartupWaitResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("daemon wait timeout must be non-negative");

  const deadline = timing.clock.now() + timeoutMs;
  const exit = Promise.resolve()
    .then(() => child.wait())
    .then((process) => ({ kind: "exited" as const, process }));
  void exit.catch(() => undefined);

  while (true) {
    const remainingMs = deadline - timing.clock.now();
    if (remainingMs <= 0) return { kind: "timeout" };

    const health = Promise.resolve()
      .then(condition)
      .then((healthy) => ({ kind: "health" as const, healthy }));
    const healthResult = await Promise.race([health, exit]);
    if (healthResult.kind === "exited") return healthResult;
    if (healthResult.healthy) return { kind: "healthy" };

    const sleepMs = Math.min(50, deadline - timing.clock.now());
    if (sleepMs <= 0) return { kind: "timeout" };
    const next = await Promise.race([
      Promise.resolve()
        .then(() => timing.scheduler.sleep(sleepMs))
        .then(() => ({ kind: "sleep" as const })),
      exit,
    ]);
    if (next.kind === "exited") return next;
  }
}

export function terminateQuietly(child: DaemonProcessHandle): void {
  try {
    child.terminate("SIGTERM");
  } catch {
    // The child may have exited already; preserve the useful health error.
  }
}
