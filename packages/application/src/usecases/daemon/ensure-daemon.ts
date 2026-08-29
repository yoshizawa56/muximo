import { type DaemonEnsureResult, DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, terminateQuietly, waitFor } from "./policy.js";

export class EnsureDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonEnsureResult> {
    const healthCheckStartedAt = this.dependencies.clock.now();
    const record = this.dependencies.runtime.readPidRecord(options.pidFile);
    if (await this.dependencies.runtime.isHealthy(options, record?.pid)) {
      return {
        state: "already-running",
        host: record?.host ?? options.host,
        port: record?.port ?? options.port,
      };
    }

    if (record && (await this.dependencies.runtime.isAlive(record.pid))) {
      throw new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid });
    }

    const startupStartedAt = this.dependencies.clock.now();
    const child = await this.dependencies.runtime.spawn(options);
    if (
      !(await waitFor(
        () => this.dependencies.runtime.isHealthy(options, child.pid),
        this.dependencies.lifecycleTimeoutMs,
        this.dependencies,
      ))
    ) {
      terminateQuietly(child);
      throw new DaemonHealthError("startup_timeout", options, {
        startedAt: startupStartedAt,
        pid: child.pid,
      });
    }
    return { state: "started", host: options.host, port: options.port };
  }
}
