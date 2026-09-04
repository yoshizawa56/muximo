import type { DaemonOptions, DaemonStartResult } from "../../ports/daemon.js";
import type { EnsureDaemon } from "./ensure-daemon.js";
import type { DaemonLifecycleDependencies } from "./policy.js";

export type StartDaemonInput = {
  options: DaemonOptions;
};

export type StartDaemonDependencies = DaemonLifecycleDependencies & {
  ensure: EnsureDaemon;
};

export class StartDaemon {
  public constructor(private readonly dependencies: StartDaemonDependencies) {}

  public async execute(input: StartDaemonInput): Promise<DaemonStartResult> {
    return { kind: "background", result: await this.dependencies.ensure.execute(input.options) };
  }
}
