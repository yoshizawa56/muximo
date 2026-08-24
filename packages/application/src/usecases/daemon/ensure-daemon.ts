import { type DaemonEnsureResult, DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, terminateQuietly, waitFor } from "./policy.js";

export class EnsureDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonEnsureResult> {
    const healthCheckStartedAt = this.dependencies.clock.now();
    if (await this.dependencies.runtime.isHealthy(options.host, options.port)) {
      return { state: "already-running", host: options.host, port: options.port };
    }

    const record = this.dependencies.runtime.readPidRecord(options.pidFile);
    if (record && (await this.dependencies.runtime.isAlive(record.pid))) {
      throw new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid });
    }

    const startupStartedAt = this.dependencies.clock.now();
    const child = this.dependencies.runtime.spawn(options);
    if (
      !(await waitFor(
        () => this.dependencies.runtime.isHealthy(options.host, options.port),
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
