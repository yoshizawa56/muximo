import { homedir } from "node:os";
import { resolve } from "node:path";
import type { MuximodConfigurationStatus, MuximodHostSettings } from "@muximo/contract/control";
import {
  createLogger,
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  errorFields,
} from "@muximo/infrastructure/runtime";
import { type MuximoConfig, readMuximoConfig, resolveInstancePaths } from "@muximo/instance-contract";
import {
  createMuximodConfigurationStatusReader,
  type MuximodConfigResolutionContext,
  resolveMuximodConfiguredExecutable,
  resolveMuximodConfiguredPath,
} from "./config-status.js";
import type { MuximodConfig, MuximodLaunchOptions } from "./launch.js";
import { consumeMuximodRestartMarker, removeMuximodPidRecord, writeMuximodPidRecord } from "./process-files.js";
import { createMuximodServer, resolveMuximodEnvironment } from "./server.js";

export type MuximodEntrypointOptions = MuximodLaunchOptions;

export type MuximodStartupConfiguration = {
  config: MuximodConfig;
  environment: NodeJS.ProcessEnv;
  hostSettings: MuximodHostSettings;
  configurationStatus: () => MuximodConfigurationStatus;
};

/** Resolves the instance-owned configuration inside the daemon process. */
export function resolveMuximodStartupConfiguration(
  options: MuximodLaunchOptions,
  instanceConfig: MuximoConfig,
  environment: NodeJS.ProcessEnv,
): MuximodStartupConfiguration {
  const paths = resolveInstancePaths(options.instanceDirectory);
  const inheritedEnvironment = resolveMuximodEnvironment(environment, options.runtimeEnvironment);
  const homeDirectory = inheritedEnvironment.HOME ?? homedir();
  const workingDirectory = resolve(options.workingDirectory);
  const resolution: MuximodConfigResolutionContext = { workingDirectory, homeDirectory };
  const allowedRoots =
    instanceConfig.workspace.roots.length === 0
      ? [homeDirectory]
      : instanceConfig.workspace.roots.map((root) => resolveMuximodConfiguredPath(root, resolution));
  const runtimeEnvironment = {
    ...options.runtimeEnvironment,
    codexRemote: instanceConfig.agents.codexRemote,
    codexBinary: resolveMuximodConfiguredExecutable(instanceConfig.agents.executables.codex, resolution),
    claudeBinary: resolveMuximodConfiguredExecutable(instanceConfig.agents.executables.claude, resolution),
    opencodeBinary: resolveMuximodConfiguredExecutable(instanceConfig.agents.executables.opencode, resolution),
    tailscaleBinary: resolveMuximodConfiguredExecutable(instanceConfig.serve.tailscale.executable, resolution),
  };
  const config: MuximodConfig = {
    host: instanceConfig.daemon.host,
    port: instanceConfig.daemon.port,
    instanceDirectory: paths.instanceDirectory,
    configFile: paths.configFile,
    hookOutputDirectory: paths.hookOutputDirectory,
    opencodeRegistryFile: paths.opencodeRegistryFile,
    pidFile: paths.pidFile,
    controlSocket: paths.controlSocket,
    allowedOrigins: [...instanceConfig.daemon.allowedOrigins],
    allowedRoots,
    logLevel: instanceConfig.logging.level,
    logFile: paths.logFile,
    workingDirectory,
    enabledAgentBackends: [...instanceConfig.agents.enabled],
    defaultAgentBackend: instanceConfig.agents.default,
    opencodeServerUrl: instanceConfig.agents.opencode.serverUrl,
    runtimeEnvironment,
  };
  const resolvedEnvironment = resolveMuximodEnvironment(environment, runtimeEnvironment);
  const tailscale = instanceConfig.serve.tailscale;
  const hostSettings: MuximodHostSettings = {
    tailscale: {
      enabled: tailscale.enabled,
      executable: runtimeEnvironment.tailscaleBinary ?? tailscale.executable,
      args: [...tailscale.args],
      hostname: tailscale.hostname,
      externalPort: tailscale.externalPort,
      path: tailscale.path,
    },
  };
  return {
    config,
    environment: resolvedEnvironment,
    hostSettings,
    configurationStatus: createMuximodConfigurationStatusReader({
      configFile: paths.configFile,
      startupConfig: instanceConfig,
      resolution,
    }),
  };
}

/** Runs the muximod runtime from a validated, typed process bootstrap. */
export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const paths = resolveInstancePaths(options.instanceDirectory);
  let logger = createLogger({
    service: "muximod",
    mode: "background",
    level: "info",
    logFile: paths.logFile,
  });
  let loggerClosed = false;
  const closeLogger = () => {
    if (loggerClosed) return;
    loggerClosed = true;
    logger.close();
  };
  let config: MuximodConfig | undefined;
  let environment = resolveMuximodEnvironment(process.env, options.runtimeEnvironment);
  let hostSettings: MuximodHostSettings | undefined;
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
        if (config) removeMuximodPidRecord(config.pidFile, process.pid);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) throw cleanupErrors[0];
    })();
    shutdownPromise = promise;
    return promise;
  };

  try {
    const instanceConfig = readMuximoConfig(paths.configFile);
    logger.close();
    logger = createLogger({
      service: "muximod",
      mode: "background",
      level: instanceConfig.logging.level,
      logFile: paths.logFile,
      showStack: instanceConfig.logging.level === "debug",
    });
    const startup = resolveMuximodStartupConfiguration(options, instanceConfig, process.env);
    config = startup.config;
    environment = startup.environment;
    hostSettings = startup.hostSettings;
    const schemaSynchronizer =
      instanceConfig.database.schemaMode === "push"
        ? createPushSchemaSynchronizer({ environment, force: true })
        : createMigrationSchemaSynchronizer();
    server = createMuximodServer({
      ...config,
      databaseFile: paths.databaseFile,
      opencodeRegistryFile: paths.opencodeRegistryFile,
      environment,
      configurationStatus: startup.configurationStatus,
      hostSettings,
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
      if (config) removeMuximodPidRecord(config.pidFile, process.pid);
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
