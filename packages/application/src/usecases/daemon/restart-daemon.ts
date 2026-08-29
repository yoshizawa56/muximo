import { DaemonHealthError, type DaemonOptions, type DaemonRestartResult } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, terminateQuietly, waitFor, waitForHealthyOrExit } from "./policy.js";
import type { StopDaemon } from "./stop-daemon.js";

export type RestartDaemonDependencies = DaemonLifecycleDependencies & {
  stop: StopDaemon;
};

export class RestartDaemon {
  public constructor(private readonly dependencies: RestartDaemonDependencies) {}

  public async execute(options: DaemonOptions): Promise<DaemonRestartResult> {
    this.dependencies.runtime.writeRestartMarker(options.pidFile, options.refreshServers === true);
    try {
      await this.dependencies.stop.execute(options);
    } catch (error) {
      this.dependencies.runtime.removeRestartMarker(options.pidFile);
      throw error;
    }

    if (await waitFor(() => this.dependencies.runtime.isHealthy(options), 1_000, this.dependencies)) {
      return { state: "restarted-by-service-manager", host: options.host, port: options.port };
    }

    const startupStartedAt = this.dependencies.clock.now();
    const child = await this.dependencies.runtime.spawn(options);
    const startup = await waitForHealthyOrExit(
      () => this.dependencies.runtime.isHealthy(options, child.pid),
      child,
      this.dependencies.lifecycleTimeoutMs,
      this.dependencies,
    );
    if (startup.kind === "exited") {
      throw new DaemonHealthError("startup_failed", options, {
        startedAt: startupStartedAt,
        pid: child.pid,
        process: startup.process,
      });
    }
    if (startup.kind === "timeout") {
      terminateQuietly(child);
      throw new DaemonHealthError("startup_timeout", options, {
        startedAt: startupStartedAt,
        pid: child.pid,
      });
    }
    return { state: "restarted", host: options.host, port: options.port };
  }
}
