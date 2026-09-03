import { Effect } from "effect";
import type { ApplicationEffect } from "../../effect.js";
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

export const waitFor = (
  condition: () => ApplicationEffect<boolean>,
  timeoutMs: number,
  timing: Pick<DaemonLifecycleDependencies, "clock" | "scheduler">,
): ApplicationEffect<boolean> => {
  const pollIntervalMs = 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    return Effect.fail(new Error("daemon wait timeout must be non-negative"));
  const deadline = timing.clock.now() + timeoutMs;
  const poll: ApplicationEffect<boolean> = Effect.gen(function* () {
    if (yield* condition()) return true;
    const remainingMs = deadline - timing.clock.now();
    if (remainingMs <= 0) return false;
    yield* timing.scheduler.sleep(Math.min(pollIntervalMs, remainingMs));
    return yield* poll;
  });
  return poll;
};

export const waitForHealthyOrExit = (
  condition: () => ApplicationEffect<boolean>,
  child: DaemonProcessHandle,
  timeoutMs: number,
  timing: Pick<DaemonLifecycleDependencies, "clock" | "scheduler">,
): ApplicationEffect<DaemonStartupWaitResult> => {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    return Effect.fail(new Error("daemon wait timeout must be non-negative"));

  const deadline = timing.clock.now() + timeoutMs;
  const exit = observeExit(child);

  const poll: ApplicationEffect<DaemonStartupWaitResult> = Effect.gen(function* () {
    const remainingMs = deadline - timing.clock.now();
    if (remainingMs <= 0) return { kind: "timeout" } as const;

    // The exit observation stays on the left: an already-settled child exit
    // wins before any further health check, mirroring the shared exit promise
    // of the original implementation.
    const healthResult = yield* Effect.race(
      exit,
      condition().pipe(Effect.map((healthy) => ({ kind: "health" as const, healthy }))),
    );
    if (healthResult.kind === "exited") return healthResult;
    if (healthResult.healthy) return { kind: "healthy" } as const;

    const sleepMs = Math.min(50, deadline - timing.clock.now());
    if (sleepMs <= 0) return { kind: "timeout" } as const;
    const next = yield* Effect.race(
      exit,
      timing.scheduler.sleep(sleepMs).pipe(Effect.map(() => ({ kind: "sleep" as const }))),
    );
    if (next.kind === "exited") return next;
    return yield* poll;
  });
  return poll;
};

export const terminateQuietly = (child: DaemonProcessHandle): ApplicationEffect<void> =>
  child.terminate("SIGTERM").pipe(
    // The child may have exited already; preserve the useful health error.
    Effect.catch(() => Effect.succeed(undefined)),
  );

function observeExit(child: DaemonProcessHandle): ApplicationEffect<{ kind: "exited"; process: ProcessResult }> {
  let waiting: ApplicationEffect<ProcessResult>;
  try {
    waiting = child.wait();
  } catch {
    return Effect.succeed({ kind: "exited" as const, process: unavailableExitStatus() });
  }
  return waiting.pipe(
    Effect.map((process) => ({ kind: "exited" as const, process })),
    Effect.catch(() => Effect.succeed({ kind: "exited" as const, process: unavailableExitStatus() })),
  );
}

function unavailableExitStatus(): ProcessResult {
  return {
    started: false,
    code: 127,
    interrupted: false,
    signal: null,
    failureDiagnostic: "muximod process exit status was unavailable",
  };
}
