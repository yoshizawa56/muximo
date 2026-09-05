import { Effect } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { DaemonClockService, DaemonLifecycleConfigService, DaemonRuntimeService } from "./daemon-services.js";
import { terminateQuietly, waitForHealthyOrExit } from "./policy.js";

export class EnsureDaemon {
  public readonly execute = Effect.fn("Daemon.ensure")(
    { self: this },
    function* (this: EnsureDaemon, options: DaemonOptions) {
      const runtime = yield* DaemonRuntimeService;
      const clock = yield* DaemonClockService;
      const config = yield* DaemonLifecycleConfigService;
      const healthCheckStartedAt = clock.now();
      const record = yield* runtime.readPidRecord(options.pidFile);
      if (yield* runtime.isHealthy(options, record?.pid)) {
        return {
          state: "already-running",
          host: record?.host ?? options.host,
          port: record?.port ?? options.port,
        } as const;
      }

      if (record && (yield* runtime.isAlive(record.pid))) {
        return yield* Effect.fail(
          new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }

      const startupStartedAt = clock.now();
      const child = yield* runtime.spawn(options);
      const startup = yield* waitForHealthyOrExit(
        () => runtime.isHealthy(options, child.pid),
        child,
        config.lifecycleTimeoutMs,
      );
      if (startup.kind === "exited") {
        return yield* Effect.fail(
          new DaemonHealthError("startup_failed", options, {
            startedAt: startupStartedAt,
            pid: child.pid,
            process: startup.process,
          }),
        );
      }
      if (startup.kind === "timeout") {
        yield* terminateQuietly(child);
        return yield* Effect.fail(
          new DaemonHealthError("startup_timeout", options, {
            startedAt: startupStartedAt,
            pid: child.pid,
          }),
        );
      }
      return { state: "started", host: options.host, port: options.port } as const;
    },
  );
}
