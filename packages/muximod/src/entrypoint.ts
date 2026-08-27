import {
  createLogger,
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  defaultOpenCodeRegistryFile,
  disposeOwnedOpenCodeServers,
  errorFields,
  refreshOwnedOpenCodeServers,
} from "@muximo/infrastructure";
import type { MuximodLaunchOptions } from "./launch.js";
import {
  consumeMuximodRestartMarker,
  hasMuximodRestartMarker,
  removeMuximodPidRecord,
  writeMuximodPidRecord,
} from "./process-files.js";
import { createMuximodServer } from "./server.js";

export type MuximodEntrypointOptions = MuximodLaunchOptions;

/** Runs the muximod runtime from a validated, typed process bootstrap. */
export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const config = options.config;
  const schemaSynchronizer =
    options.schemaMode === "push" ? createPushSchemaSynchronizer({ force: true }) : createMigrationSchemaSynchronizer();
  const logger = createLogger({
    service: "muximod",
    mode: config.logFile ? "background" : "attached",
    level: config.logLevel,
    logFile: config.logFile,
    showStack: config.logLevel === "debug",
  });
  const server = createMuximodServer({
    ...config,
    schemaSynchronizer,
    logger,
  });

  try {
    await server.start();
    writeMuximodPidRecord(config.pidFile, {
      pid: process.pid,
      host: config.host,
      port: config.port,
      startedAt: new Date().toISOString(),
    });
    if (consumeMuximodRestartMarker(config.pidFile) === true) {
      void refreshOwnedOpenCodeServers({
        logger,
        registryFile: defaultOpenCodeRegistryFile(process.env),
      });
    }
  } catch (error) {
    logger.error("process.unhandled_error", {
      message: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      ...errorFields(error),
    });
    server.stop();
    logger.close();
    throw error;
  }

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    removeMuximodPidRecord(config.pidFile, process.pid);
    const restarting = hasMuximodRestartMarker(config.pidFile);
    server.stop();
    if (restarting) {
      logger.close();
      return;
    }
    void disposeOwnedOpenCodeServers({
      logger,
      registryFile: defaultOpenCodeRegistryFile(process.env),
    })
      .finally(() => logger.close())
      .catch(() => undefined);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
