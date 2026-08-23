import type { Logger } from "@muximo/infrastructure";
import { errorFields, OpenCodeServerManager } from "@muximo/infrastructure";

export async function disposeOwnedOpenCodeServers(options: { registryFile: string; logger?: Logger }): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile,
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
    options.logger?.warn("opencode.server_cleanup_failed", {
      ...errorFields(error),
    });
  }
}

/**
 * Restart every owned OpenCode server on the port it already uses, so a
 * `muximo daemon restart` picks up configuration and environment changes while
 * keeping the server URLs stable. Best effort; failures are logged and the
 * affected root is released from the registry.
 */
export async function refreshOwnedOpenCodeServers(options: { registryFile: string; logger?: Logger }): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile,
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
    options.logger?.warn("opencode.server_refresh_failed", {
      ...errorFields(error),
    });
  }
}
