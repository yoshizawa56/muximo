import type { DaemonOptions, DaemonStatusResult } from "../../ports/daemon.js";
import type { DaemonLifecycleDependencies } from "./policy.js";

export class StatusDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonStatusResult> {
    const healthCheckStartedAt = this.dependencies.clock.now();
    const record = this.dependencies.runtime.readPidRecord(options.pidFile);
    if (await this.dependencies.runtime.isHealthy(options, record?.pid)) {
      return {
        state: "running",
        host: record?.host ?? options.host,
        port: record?.port ?? options.port,
        pid: record?.pid,
      };
    }

    if (record && (await this.dependencies.runtime.isAlive(record.pid))) {
      return {
        state: "unhealthy",
        host: record.host,
        port: record.port,
        pid: record.pid,
        logFile: options.logFile,
        healthFailure: { startedAt: healthCheckStartedAt, pid: record.pid },
      };
    }

    if (record) this.dependencies.runtime.removePidRecord(options.pidFile, record.pid);
    return { state: "stopped", host: options.host, port: options.port };
  }
}
