import { Effect } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, waitFor } from "./policy.js";

export class StopDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public readonly execute = Effect.fn("Daemon.stop")(
    { self: this },
    function* (this: StopDaemon, options: DaemonOptions) {
      const dependencies = this.dependencies;
      const healthCheckStartedAt = dependencies.clock.now();
      const record = yield* dependencies.runtime.readPidRecord(options.pidFile);
      if (!record) {
        if (yield* dependencies.runtime.isHealthy(options)) {
          return yield* Effect.fail(
            new DaemonHealthError("healthy_without_pid", options, { startedAt: healthCheckStartedAt }),
          );
        }
        return { state: "already-stopped", reason: "missing-pid" } as const;
      }

      if (!(yield* dependencies.runtime.isAlive(record.pid))) {
        yield* dependencies.runtime.removePidRecord(options.pidFile, record.pid);
        return { state: "already-stopped", reason: "stale-pid" } as const;
      }

      const recordOptions = { ...options, host: record.host, port: record.port };
      const isCurrentConfigurationHealthy = yield* dependencies.runtime.isHealthy(recordOptions, record.pid);
      const isOwnedProcessHealthy = isCurrentConfigurationHealthy
        ? true
        : yield* dependencies.runtime.isProcessHealthy(recordOptions, record.pid);
      if (!isOwnedProcessHealthy) {
        return yield* Effect.fail(
          new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }

      yield* dependencies.runtime.signal(record.pid, "SIGTERM");
      const stopped = yield* waitFor(
        () => dependencies.runtime.isAlive(record.pid).pipe(Effect.map((alive) => !alive)),
        dependencies.lifecycleTimeoutMs,
        dependencies,
      );
      if (!stopped) {
        return yield* Effect.fail(
          new DaemonHealthError("stop_timeout", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }
      yield* dependencies.runtime.removePidRecord(options.pidFile, record.pid);
      return { state: "stopped" } as const;
    },
  );
}
