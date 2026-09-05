import { Effect } from "effect";
import type { DaemonOptions } from "../../ports/daemon.js";
import { DaemonRuntimeService } from "./daemon-services.js";
import { EnsureDaemon } from "./ensure-daemon.js";

export type StartDaemonInput = {
  options: DaemonOptions;
  foreground: boolean;
};

export class StartDaemon {
  public readonly execute = Effect.fn("Daemon.start")(
    { self: this },
    function* (this: StartDaemon, input: StartDaemonInput) {
      const runtime = yield* DaemonRuntimeService;
      if (input.foreground) {
        return {
          kind: "foreground" as const,
          process: yield* runtime.runForeground(input.options),
        };
      }
      return {
        kind: "background" as const,
        result: yield* new EnsureDaemon().execute(input.options),
      };
    },
  );
}
