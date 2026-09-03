import { Effect } from "effect";
import type { DaemonOptions } from "../../ports/daemon.js";
import type { DaemonLifecycleDependencies } from "./policy.js";

export class StatusDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public readonly execute = Effect.fn("Daemon.status")(
    { self: this },
    function* (this: StatusDaemon, options: DaemonOptions) {
      const dependencies = this.dependencies;
      const healthCheckStartedAt = dependencies.clock.now();
      const record = yield* dependencies.runtime.readPidRecord(options.pidFile);
      if (yield* dependencies.runtime.isHealthy(options, record?.pid)) {
        return {
          state: "running",
          host: record?.host ?? options.host,
          port: record?.port ?? options.port,
          pid: record?.pid,
        } as const;
      }

      if (record && (yield* dependencies.runtime.isAlive(record.pid))) {
        return {
          state: "unhealthy",
          host: record.host,
          port: record.port,
          pid: record.pid,
          logFile: options.logFile,
          healthFailure: { startedAt: healthCheckStartedAt, pid: record.pid },
        } as const;
      }

      if (record) yield* dependencies.runtime.removePidRecord(options.pidFile, record.pid);
      return { state: "stopped", host: options.host, port: options.port } as const;
    },
  );
}
