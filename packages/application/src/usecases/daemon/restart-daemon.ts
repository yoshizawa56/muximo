import { Effect, Result } from "effect";
import { DaemonHealthError, type DaemonOptions } from "../../ports/daemon.js";
import { DaemonClockService, DaemonLifecycleConfigService, DaemonRuntimeService } from "./daemon-services.js";
import { terminateQuietly, waitFor, waitForHealthyOrExit } from "./policy.js";
import { StopDaemon } from "./stop-daemon.js";

export class RestartDaemon {
  public readonly execute = Effect.fn("Daemon.restart")(
    { self: this },
    function* (this: RestartDaemon, options: DaemonOptions) {
      const runtime = yield* DaemonRuntimeService;
      const clock = yield* DaemonClockService;
      const config = yield* DaemonLifecycleConfigService;
      yield* runtime.writeRestartMarker(options.pidFile, options.refreshServers === true);
      const stopped = yield* Effect.result(new StopDaemon().execute(options));
      if (Result.isFailure(stopped)) {
        yield* runtime.removeRestartMarker(options.pidFile).pipe(Effect.catch(() => Effect.succeed(undefined)));
        return yield* Effect.fail(stopped.failure);
      }

      if (yield* waitFor(() => runtime.isHealthy(options), 1_000)) {
        return { state: "restarted-by-service-manager" as const, host: options.host, port: options.port };
      }

      const startupStartedAt = clock.now();
      const child = yield* runtime.spawn(options);
      const startup = yield* waitForHealthyOrExit(
        () => runtime.isHealthy(options, child.pid),
        child,
        config.lifecycleTimeoutMs,
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
