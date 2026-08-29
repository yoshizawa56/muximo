import { errorFields, type Logger } from "../../logging/index.js";
import { defaultOpenCodeRegistryFile, OpenCodeServerManager } from "./server.js";

export async function disposeOwnedOpenCodeServers(
  options: { environment?: NodeJS.ProcessEnv; registryFile?: string; logger?: Logger } = {},
): Promise<void> {
  const manager = new OpenCodeServerManager({
    environment: options.environment,
    registryFile: options.registryFile ?? defaultOpenCodeRegistryFile(options.environment),
    onLog: (level, message, extra) => {
      if (level === "warn" || level === "error") {
        options.logger?.warn("opencode.server_cleanup", { message, ...extra });
      } else {
        options.logger?.debug("opencode.server_cleanup", { message, ...extra });
      }
    },
  });
  try {
    await manager.disposeAll();
  } catch (error) {
    options.logger?.warn("opencode.server_cleanup_failed", { ...errorFields(error) });
    throw error;
  }
}

/** Refreshes owned servers while preserving their registered ports. */
export async function refreshOwnedOpenCodeServers(
  options: { environment?: NodeJS.ProcessEnv; registryFile?: string; logger?: Logger } = {},
): Promise<void> {
  const manager = new OpenCodeServerManager({
    environment: options.environment,
    registryFile: options.registryFile ?? defaultOpenCodeRegistryFile(options.environment),
    onLog: (level, message, extra) => {
      if (level === "warn" || level === "error") {
        options.logger?.warn("opencode.server_refresh", { message, ...extra });
      } else {
        options.logger?.debug("opencode.server_refresh", { message, ...extra });
      }
    },
  });
  try {
    await manager.refreshAll();
  } catch (error) {
    options.logger?.warn("opencode.server_refresh_failed", { ...errorFields(error) });
  }
}
