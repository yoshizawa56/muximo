import { DaemonHealthError, type DaemonOptions, type DaemonStopResult } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, waitFor } from "./policy.js";

export class StopDaemon {
  public constructor(private readonly dependencies: DaemonLifecycleDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonStopResult> {
    const healthCheckStartedAt = this.dependencies.clock.now();
    const record = this.dependencies.runtime.readPidRecord(options.pidFile);
    if (!record) {
      if (await this.dependencies.runtime.isHealthy(options.host, options.port)) {
        throw new DaemonHealthError("healthy_without_pid", options, { startedAt: healthCheckStartedAt });
      }
      return { state: "already-stopped", reason: "missing-pid" };
    }

    if (!(await this.dependencies.runtime.isAlive(record.pid))) {
      this.dependencies.runtime.removePidRecord(options.pidFile, record.pid);
      return { state: "already-stopped", reason: "stale-pid" };
    }

    const recordOptions = { ...options, host: record.host, port: record.port };
    if (!(await this.dependencies.runtime.isHealthy(recordOptions.host, recordOptions.port))) {
      throw new DaemonHealthError("pid_unhealthy", options, { startedAt: healthCheckStartedAt, pid: record.pid });
    }

    this.dependencies.runtime.signal(record.pid, "SIGTERM");
    const stopped = await waitFor(
      () => this.dependencies.runtime.isAlive(record.pid).then((alive) => !alive),
      this.dependencies.lifecycleTimeoutMs,
      this.dependencies,
    );
    if (!stopped) {
      throw new DaemonHealthError("stop_timeout", options, { startedAt: healthCheckStartedAt, pid: record.pid });
    }
    this.dependencies.runtime.removePidRecord(options.pidFile, record.pid);
    return { state: "stopped" };
  }
}
