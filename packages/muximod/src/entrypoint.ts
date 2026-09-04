import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { MuximodHostSettings } from "@muximo/contract/control";
import {
  createLogger,
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  errorFields,
} from "@muximo/infrastructure/runtime";
import { type MuximoConfig, readMuximoConfig } from "@muximo/profile";
import { type MuximodConfig, type MuximodLaunchOptions, muximodConfigurationFingerprint } from "./launch.js";
import { consumeMuximodRestartMarker, removeMuximodPidRecord, writeMuximodPidRecord } from "./process-files.js";
import { createMuximodServer, resolveMuximodEnvironment } from "./server.js";

export type MuximodEntrypointOptions = MuximodLaunchOptions;

export type MuximodStartupConfiguration = {
  config: MuximodConfig;
  environment: NodeJS.ProcessEnv;
  hostSettings: MuximodHostSettings;
};

/** Resolves the instance-owned configuration inside the daemon process. */
export function resolveMuximodStartupConfiguration(
  options: MuximodLaunchOptions,
  instanceConfig: MuximoConfig,
  environment: NodeJS.ProcessEnv,
): MuximodStartupConfiguration {
  const bootstrapConfig = options.config;
  const inheritedEnvironment = resolveMuximodEnvironment(environment, bootstrapConfig.runtimeEnvironment);
  const homeDirectory = inheritedEnvironment.HOME ?? homedir();
  const allowedRoots = hasWorkspaceRoots(inheritedEnvironment)
    ? bootstrapConfig.allowedRoots
    : instanceConfig.workspace.roots.length === 0
      ? bootstrapConfig.allowedRoots
      : instanceConfig.workspace.roots.map((root) =>
          resolveConfiguredPath(root, bootstrapConfig.workingDirectory, homeDirectory),
        );
  const runtimeEnvironment = {
    ...bootstrapConfig.runtimeEnvironment,
    codexBinary:
      bootstrapConfig.runtimeEnvironment.codexBinary ??
      expandConfiguredExecutable(instanceConfig.agents.executables.codex, homeDirectory),
    claudeBinary:
      bootstrapConfig.runtimeEnvironment.claudeBinary ??
      expandConfiguredExecutable(instanceConfig.agents.executables.claude, homeDirectory),
    opencodeBinary:
      bootstrapConfig.runtimeEnvironment.opencodeBinary ??
      expandConfiguredExecutable(instanceConfig.agents.executables.opencode, homeDirectory),
    tailscaleBinary:
      bootstrapConfig.runtimeEnvironment.tailscaleBinary ??
      expandConfiguredExecutable(instanceConfig.serve.tailscale.executable, homeDirectory),
  };
  const config: MuximodConfig = {
    ...bootstrapConfig,
    allowedRoots,
    enabledAgentBackends: [...instanceConfig.agents.enabled],
    defaultAgentBackend: instanceConfig.agents.default,
    runtimeEnvironment,
  };
  const resolvedEnvironment = resolveMuximodEnvironment(environment, runtimeEnvironment);
  const tailscale = instanceConfig.serve.tailscale;
  const hostSettings: MuximodHostSettings = {
    tailscale: {
      enabled: tailscale.enabled,
      executable: runtimeEnvironment.tailscaleBinary ?? tailscale.executable,
      args: resolveTailscaleArgs(resolvedEnvironment.MUXIMO_TAILSCALE_ARGS, tailscale.args),
      hostname: resolveOptionalEnvironmentValue(resolvedEnvironment.MUXIMO_TAILSCALE_HOSTNAME, tailscale.hostname),
      externalPort: tailscale.externalPort,
      path: resolveEnvironmentValue(resolvedEnvironment.MUXIMO_TAILSCALE_PATH, tailscale.path),
    },
  };
  return { config, environment: resolvedEnvironment, hostSettings };
}

/** Runs the muximod runtime from a validated, typed process bootstrap. */
export async function runMuximod(options: MuximodEntrypointOptions): Promise<void> {
  const bootstrapConfig = options.config;
  const configurationFingerprint = muximodConfigurationFingerprint(options);
  const logger = createLogger({
    service: "muximod",
    mode: bootstrapConfig.logFile ? "background" : "attached",
    level: bootstrapConfig.logLevel,
    logFile: bootstrapConfig.logFile,
    showStack: bootstrapConfig.logLevel === "debug",
  });
  let loggerClosed = false;
  const closeLogger = () => {
    if (loggerClosed) return;
    loggerClosed = true;
    logger.close();
  };
  let config = bootstrapConfig;
  let environment = resolveMuximodEnvironment(process.env, bootstrapConfig.runtimeEnvironment);
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
    const startup = resolveMuximodStartupConfiguration(
      options,
      readMuximoConfig(bootstrapConfig.configFile),
      process.env,
    );
    config = startup.config;
    environment = startup.environment;
    hostSettings = startup.hostSettings;
    const schemaSynchronizer =
      options.schemaMode === "push"
        ? createPushSchemaSynchronizer({ environment, force: true })
        : createMigrationSchemaSynchronizer();
    server = createMuximodServer({
      ...config,
      environment,
      configurationFingerprint,
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

function hasWorkspaceRoots(environment: NodeJS.ProcessEnv): boolean {
  return environment.MUXIMOD_WORKSPACE_ROOTS?.trim() !== undefined;
}

function expandConfiguredExecutable(value: string | undefined, homeDirectory: string): string | null {
  if (value === undefined) return null;
  if (value === "~") return homeDirectory;
  return value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
}

function resolveConfiguredPath(value: string, baseDirectory: string, homeDirectory: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(baseDirectory, expanded));
}

function resolveTailscaleArgs(value: string | undefined, fallback: readonly string[]): string[] {
  if (value === undefined || value.trim() === "") return [...fallback];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("MUXIMO_TAILSCALE_ARGS must be a JSON array of strings", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("MUXIMO_TAILSCALE_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function resolveEnvironmentValue(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function resolveOptionalEnvironmentValue(value: string | undefined, fallback: string | null): string | null {
  return value === undefined ? fallback : value.trim() || null;
}
