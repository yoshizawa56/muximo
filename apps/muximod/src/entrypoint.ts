#!/usr/bin/env bun
import {
  createLogger,
  type DatabaseSchemaSynchronizer,
  defaultOpenCodeRegistryFile,
  disposeOwnedOpenCodeServers,
  errorFields,
  type LogLevel,
  MuximodDaemonProcess,
  refreshOwnedOpenCodeServers,
  resolveMuximodPaths,
} from "@muximo/infrastructure";
import { createMuximodServer } from "./server.js";

export type MuximodEntrypointOptions = {
  schemaSynchronizer: DatabaseSchemaSynchronizer;
};

export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const environment = process.env;
  const paths = resolveMuximodPaths(environment);
  const host = environment.MUXIMOD_HOST ?? "127.0.0.1";
  const port = readPort(environment.MUXIMOD_PORT);
  const logLevel = readLogLevel(environment.MUXIMO_LOG_LEVEL);
  const logger = createLogger({
    service: "muximod",
    mode: environment.MUXIMO_LOG_FILE ? "background" : "attached",
    level: logLevel,
    logFile: environment.MUXIMO_LOG_FILE,
    showStack: logLevel === "debug",
  });
  const processAdapter = new MuximodDaemonProcess({ environment });
  const server = createMuximodServer({
    host,
    port,
    schemaSynchronizer: options.schemaSynchronizer,
    databaseFile: paths.databaseFile,
    controlSocket: paths.controlSocket,
    muximodBaseUrl: environment.MUXIMOD_PAIRING_BASE_URL,
    allowedOrigins: readOrigins(environment.MUXIMOD_ALLOWED_ORIGINS),
    logger,
    logLevel,
    logFile: environment.MUXIMO_LOG_FILE,
  });

  try {
    await server.start();
    processAdapter.writePidRecord(paths.pidFile, {
      pid: process.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
    });
    if (processAdapter.consumeRestartMarker(paths.pidFile) === true) {
      void refreshOwnedOpenCodeServers({
        logger,
        registryFile: defaultOpenCodeRegistryFile(environment),
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
    processAdapter.removePidRecord(paths.pidFile, process.pid);
    if (processAdapter.hasRestartMarker(paths.pidFile)) {
      server.stop();
      logger.close();
      return;
    }
    void disposeOwnedOpenCodeServers({
      logger,
      registryFile: defaultOpenCodeRegistryFile(environment),
    }).finally(() => {
      server.stop();
      logger.close();
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function readPort(value: string | undefined): number {
  const port = Number(value ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MUXIMOD_PORT must be between 1 and 65535");
  }
  return port;
}

function readLogLevel(value: string | undefined): LogLevel {
  const level = value ?? "info";
  if (level !== "error" && level !== "warn" && level !== "info" && level !== "debug") {
    throw new Error("MUXIMO_LOG_LEVEL must be one of error, warn, info, or debug");
  }
  return level;
}

function readOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
