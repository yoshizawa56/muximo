import { errorFields, type Logger } from "../../logging/index.js";
import { defaultOpenCodeRegistryFile, OpenCodeServerManager } from "./server.js";

export async function disposeOwnedOpenCodeServers(
  options: { registryFile?: string; logger?: Logger } = {},
): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile ?? defaultOpenCodeRegistryFile(),
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
  options: { registryFile?: string; logger?: Logger } = {},
): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile ?? defaultOpenCodeRegistryFile(),
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
