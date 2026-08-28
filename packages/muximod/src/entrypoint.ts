import { join } from "node:path";
import {
  createLogger,
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  disposeOwnedOpenCodeServers,
  errorFields,
  refreshOwnedOpenCodeServers,
} from "@muximo/infrastructure/runtime";
import { type MuximodLaunchOptions, muximodConfigurationFingerprint } from "./launch.js";
import {
  consumeMuximodRestartMarker,
  hasMuximodRestartMarker,
  removeMuximodPidRecord,
  writeMuximodPidRecord,
} from "./process-files.js";
import { createMuximodServer, resolveMuximodEnvironment } from "./server.js";

export type MuximodEntrypointOptions = MuximodLaunchOptions;

/** Runs the muximod runtime from a validated, typed process bootstrap. */
export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const config = options.config;
  const environment = resolveMuximodEnvironment(process.env, config.runtimeEnvironment);
  const schemaSynchronizer =
    options.schemaMode === "push"
      ? createPushSchemaSynchronizer({ environment, force: true })
      : createMigrationSchemaSynchronizer();
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
      const restarting = hasMuximodRestartMarker(config.pidFile);
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
      if (!restarting) {
        try {
          await disposeOwnedOpenCodeServers({
            environment,
            logger,
            registryFile: join(config.instanceDirectory, "opencode-servers.json"),
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw cleanupErrors[0];
    })();
    shutdownPromise = promise;
    return promise;
  };

  try {
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
    if (consumeMuximodRestartMarker(config.pidFile) === true) {
      await refreshOwnedOpenCodeServers({
        environment,
        logger,
        registryFile: join(config.instanceDirectory, "opencode-servers.json"),
      });
    }
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
    if (!hasMuximodRestartMarker(config.pidFile)) {
      try {
        await disposeOwnedOpenCodeServers({
          environment,
          logger,
          registryFile: join(config.instanceDirectory, "opencode-servers.json"),
        });
      } catch (cleanupError) {
        logger.warn("process.sidecar_cleanup_failed", errorFields(cleanupError));
      }
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
