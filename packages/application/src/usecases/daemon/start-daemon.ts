import { Effect } from "effect";
import type { DaemonOptions } from "../../ports/daemon.js";
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

  public readonly execute = Effect.fn("Daemon.start")(
    { self: this },
    function* (this: StartDaemon, input: StartDaemonInput) {
      if (input.foreground) {
        return {
          kind: "foreground" as const,
          process: yield* this.dependencies.runtime.runForeground(input.options),
        };
      }
      return {
        kind: "background" as const,
        result: yield* this.dependencies.ensure.execute(input.options),
      };
    },
  );
}
