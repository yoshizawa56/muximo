import { Effect } from "effect";
import type { DaemonOptions } from "../../ports/daemon.js";
import { DaemonClockService, DaemonRuntimeService } from "./daemon-services.js";

export class StatusDaemon {
  public readonly execute = Effect.fn("Daemon.status")(
    { self: this },
    function* (this: StatusDaemon, options: DaemonOptions) {
      const runtime = yield* DaemonRuntimeService;
      const clock = yield* DaemonClockService;
      const healthCheckStartedAt = clock.now();
      const record = yield* runtime.readPidRecord(options.pidFile);
      if (yield* runtime.isHealthy(options, record?.pid)) {
        return {
          state: "running",
          host: record?.host ?? options.host,
          port: record?.port ?? options.port,
          pid: record?.pid,
        } as const;
      }

      if (record && (yield* runtime.isAlive(record.pid))) {
        return {
          state: "unhealthy",
          host: record.host,
          port: record.port,
          pid: record.pid,
          logFile: options.logFile,
          healthFailure: { startedAt: healthCheckStartedAt, pid: record.pid },
        } as const;
      }

      if (record) yield* runtime.removePidRecord(options.pidFile, record.pid);
      return { state: "stopped", host: options.host, port: options.port } as const;
    },
  );
}
