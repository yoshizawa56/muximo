import { Effect, Result } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { type DaemonLifecycleDependencies, terminateQuietly, waitFor, waitForHealthyOrExit } from "./policy.js";
import type { StopDaemon } from "./stop-daemon.js";

export type RestartDaemonDependencies = DaemonLifecycleDependencies & {
  stop: StopDaemon;
};

export class RestartDaemon {
  public constructor(private readonly dependencies: RestartDaemonDependencies) {}

  public readonly execute = Effect.fn("Daemon.restart")(
    { self: this },
    function* (this: RestartDaemon, options: DaemonOptions) {
      const dependencies = this.dependencies;
      yield* dependencies.runtime.writeRestartMarker(options.pidFile, options.refreshServers === true);
      const stopped = yield* Effect.result(dependencies.stop.execute(options));
      if (Result.isFailure(stopped)) {
        yield* dependencies.runtime
          .removeRestartMarker(options.pidFile)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return yield* Effect.fail(stopped.failure);
      }

      if (yield* waitFor(() => dependencies.runtime.isHealthy(options), 1_000, dependencies)) {
        return { state: "restarted-by-service-manager" as const, host: options.host, port: options.port };
      }

      const startupStartedAt = dependencies.clock.now();
      const child = yield* dependencies.runtime.spawn(options);
      const startup = yield* waitForHealthyOrExit(
        () => dependencies.runtime.isHealthy(options, child.pid),
        child,
        dependencies.lifecycleTimeoutMs,
        dependencies,
      );
      if (startup.kind === "exited") {
        return yield* Effect.fail(
          new DaemonHealthError("startup_failed", options, {
            startedAt: startupStartedAt,
            pid: child.pid,
            process: startup.process,
          }),
        );
      }
      if (startup.kind === "timeout") {
        yield* terminateQuietly(child);
        return yield* Effect.fail(
          new DaemonHealthError("startup_timeout", options, {
            startedAt: startupStartedAt,
            pid: child.pid,
          }),
        );
      }
      return { state: "restarted" as const, host: options.host, port: options.port };
    },
  );
}
