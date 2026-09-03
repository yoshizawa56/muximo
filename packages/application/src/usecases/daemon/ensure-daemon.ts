import { Effect } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, terminateQuietly, waitForHealthyOrExit } from "./policy.js";

export class EnsureDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public readonly execute = Effect.fn("Daemon.ensure")(
    { self: this },
    function* (this: EnsureDaemon, options: DaemonOptions) {
      const dependencies = this.dependencies;
      const healthCheckStartedAt = dependencies.clock.now();
      const record = yield* dependencies.runtime.readPidRecord(options.pidFile);
      if (yield* dependencies.runtime.isHealthy(options, record?.pid)) {
        return {
          state: "already-running",
          host: record?.host ?? options.host,
          port: record?.port ?? options.port,
        } as const;
      }

      if (record && (yield* dependencies.runtime.isAlive(record.pid))) {
        return yield* Effect.fail(
          new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid }),
        );
      }

      const startupStartedAt = dependencies.clock.now();
      const child = yield* dependencies.runtime.spawn(options);
      const startup = yield* waitForHealthyOrExit(
        () => dependencies.runtime.isHealthy(options, child.pid),
        child,
        dependencies.lifecycleTimeoutMs,
        dependencies,
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
