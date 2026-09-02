import {
  createLogger,
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  errorFields,
} from "@muximo/infrastructure/runtime";
import { type MuximodLaunchOptions, muximodConfigurationFingerprint } from "./launch.js";
import { consumeMuximodRestartMarker, removeMuximodPidRecord, writeMuximodPidRecord } from "./process-files.js";
import { createMuximodServer, resolveMuximodEnvironment } from "./server.js";

export type MuximodEntrypointOptions = MuximodLaunchOptions;

/** Runs the muximod runtime from a validated, typed process bootstrap. */
export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const config = options.config;
  const environment = resolveMuximodEnvironment(process.env, config.runtimeEnvironment);
  const logger = createLogger({
    service: "muximod",
    mode: config.logFile ? "background" : "attached",
    level: config.logLevel,
    logFile: config.logFile,
    showStack: config.logLevel === "debug",
  });
  let loggerClosed = false;
  const closeLogger = () => {
    if (loggerClosed) return;
    loggerClosed = true;
    logger.close();
  };
  let server: ReturnType<typeof createMuximodServer> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let signalRequested = false;
  let resolveSignal: (() => void) | undefined;
  const onSignal = () => {
    signalRequested = true;
    resolveSignal?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    const promise = (async () => {
      const cleanupErrors: unknown[] = [];
      try {
        await server?.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        removeMuximodPidRecord(config.pidFile, process.pid);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw cleanupErrors[0];
    })();
    shutdownPromise = promise;
    return promise;
  };

  try {
    const schemaSynchronizer =
      options.schemaMode === "push"
        ? createPushSchemaSynchronizer({ environment, force: true })
        : createMigrationSchemaSynchronizer();
    server = createMuximodServer({
      ...config,
      environment,
      configurationFingerprint: muximodConfigurationFingerprint(options),
      schemaSynchronizer,
      logger,
    });
    await server.start();
    writeMuximodPidRecord(config.pidFile, {
      pid: process.pid,
      host: config.host,
      port: config.port,
      startedAt: new Date().toISOString(),
    });
    // Restart markers are retained for daemon launch coordination only. An
    // OpenCode server is a shared service reference and must not be refreshed
    // or stopped as part of daemon lifecycle.
    consumeMuximodRestartMarker(config.pidFile);
  } catch (error) {
    logger.error("process.unhandled_error", {
      message: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      ...errorFields(error),
    });
    try {
      await server?.stop();
    } catch {
      // Preserve the startup error while still attempting all cleanup below.
    }
    try {
      removeMuximodPidRecord(config.pidFile, process.pid);
    } catch {
      // Preserve the startup error after attempting to remove the pid record.
    }
    closeLogger();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    throw error;
  }

  await new Promise<void>((resolvePromise) => {
    resolveSignal = resolvePromise;
    if (signalRequested) resolvePromise();
  });
  try {
    await shutdown();
  } catch (error) {
    logger.error("process.shutdown_failed", {
      message: `unexpected shutdown error: ${error instanceof Error ? error.message : String(error)}`,
      ...errorFields(error),
    });
  } finally {
    closeLogger();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
