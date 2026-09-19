import type { DaemonOptions, DaemonStatusResult } from "../../ports/daemon.js";
import type { DaemonLifecycleDependencies } from "./policy.js";

export class StatusDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonStatusResult> {
    const healthCheckStartedAt = this.dependencies.clock.now();
    const record = this.dependencies.runtime.readPidRecord(options.pidFile);
    if (await this.dependencies.runtime.isHealthy(options, record?.pid)) {
      const launch = record ? this.dependencies.runtime.readLaunchRecord(options.pidFile) : undefined;
      return {
        state: "running",
        ...(record === undefined ? {} : { host: record.host, port: record.port }),
        pid: record?.pid,
        ...(launch !== undefined && launch.pid === record?.pid ? { launch } : {}),
      };
    }

    if (record && (await this.dependencies.runtime.isAlive(record.pid))) {
      const launch = this.dependencies.runtime.readLaunchRecord(options.pidFile);
      return {
        state: "unhealthy",
        host: record.host,
        port: record.port,
        pid: record.pid,
        logFile: options.logFile,
        healthFailure: { startedAt: healthCheckStartedAt, pid: record.pid },
        ...(launch !== undefined && launch.pid === record.pid ? { launch } : {}),
      };
    }

    if (record) this.dependencies.runtime.removePidRecord(options.pidFile, record.pid);
    return { state: "stopped" };
  }
}
