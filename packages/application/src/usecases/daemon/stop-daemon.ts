import { Effect } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { DaemonClockService, DaemonLifecycleConfigService, DaemonRuntimeService } from "./daemon-services.js";
import { waitFor } from "./policy.js";

export class StopDaemon {
  public readonly execute = Effect.fn("Daemon.stop")(
    { self: this },
    function* (this: StopDaemon, options: DaemonOptions) {
      const runtime = yield* DaemonRuntimeService;
      const clock = yield* DaemonClockService;
      const config = yield* DaemonLifecycleConfigService;
      const healthCheckStartedAt = clock.now();
      const record = yield* runtime.readPidRecord(options.pidFile);
      if (!record) {
        if (yield* runtime.isHealthy(options)) {
          return yield* Effect.fail(
            new DaemonHealthError("healthy_without_pid", options, { startedAt: healthCheckStartedAt }),
          );
        }
        return { state: "already-stopped", reason: "missing-pid" } as const;
      }

      if (!(yield* runtime.isAlive(record.pid))) {
        yield* runtime.removePidRecord(options.pidFile, record.pid);
        return { state: "already-stopped", reason: "stale-pid" } as const;
      }

      const recordOptions = { ...options, host: record.host, port: record.port };
      const isCurrentConfigurationHealthy = yield* runtime.isHealthy(recordOptions, record.pid);
      const isOwnedProcessHealthy = isCurrentConfigurationHealthy
        ? true
        : yield* runtime.isProcessHealthy(recordOptions, record.pid);
      if (!isOwnedProcessHealthy) {
        return yield* Effect.fail(
          new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }

      yield* runtime.signal(record.pid, "SIGTERM");
      const stopped = yield* waitFor(
        () => runtime.isAlive(record.pid).pipe(Effect.map((alive) => !alive)),
        config.lifecycleTimeoutMs,
      );
      if (!stopped) {
        return yield* Effect.fail(
          new DaemonHealthError("stop_timeout", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }
      yield* runtime.removePidRecord(options.pidFile, record.pid);
      return { state: "stopped" } as const;
    },
  );
}
