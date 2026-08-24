import type { DaemonOptions, DaemonStartResult } from "../../ports/daemon.js";
import type { EnsureDaemon } from "./ensure-daemon.js";
import type { DaemonLifecycleDependencies } from "./policy.js";

export type StartDaemonInput = {
  options: DaemonOptions;
  foreground: boolean;
};

export type StartDaemonDependencies = DaemonLifecycleDependencies & {
  ensure: EnsureDaemon;
};

export class StartDaemon {
  public constructor(private readonly dependencies: StartDaemonDependencies) {}

  public async execute(input: StartDaemonInput): Promise<DaemonStartResult> {
    if (input.foreground) {
      return {
        kind: "foreground",
        process: await this.dependencies.runtime.runForeground(input.options),
      };
    }
    return { kind: "background", result: await this.dependencies.ensure.execute(input.options) };
  }
}
