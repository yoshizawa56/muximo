import { join, resolve } from "node:path";
import type { MuximodConfigurationStatus } from "@muximo/contract/control";
import {
  getMuximoConfigValue,
  type MuximoConfig,
  type MuximoConfigKey,
  type MuximoConfigValue,
  muximoConfigSettings,
  readMuximoConfig,
} from "@muximo/instance-contract";

export type MuximodConfigResolutionContext = {
  workingDirectory: string;
  homeDirectory: string;
};

export type MuximodCanonicalConfig = Readonly<Record<MuximoConfigKey, MuximoConfigValue>>;

/** Resolves a config filesystem path using the daemon's startup context. */
export function resolveMuximodConfiguredPath(value: string, context: MuximodConfigResolutionContext): string {
  return value === "~"
    ? context.homeDirectory
    : value.startsWith("~/")
      ? join(context.homeDirectory, value.slice(2))
      : resolve(context.workingDirectory, value);
}

/** Resolves an explicit executable path while preserving bare PATH commands. */
export function resolveMuximodConfiguredExecutable(
  value: string | undefined,
  context: MuximodConfigResolutionContext,
): string | null {
  if (value === undefined) return null;
  const expanded =
    value === "~"
      ? context.homeDirectory
      : value.startsWith("~/")
        ? join(context.homeDirectory, value.slice(2))
        : value;
  // Match the provider launcher: bare names are resolved through PATH at
  // execution time, while explicit paths are anchored to the daemon cwd.
  return expanded.includes("/") ? resolve(context.workingDirectory, expanded) : expanded;
}

/**
 * Produces the daemon's canonical view of the instance configuration.
 *
 * This projection contains only values originating in config.json. Runtime
 * context such as HOME, PATH, cwd, process identity, and instance files is
 * deliberately not part of it.
 */
export function canonicalizeMuximoConfig(
  config: MuximoConfig,
  context: MuximodConfigResolutionContext,
): MuximodCanonicalConfig {
  const values = Object.fromEntries(
    muximoConfigSettings.map((setting) => [setting.key, canonicalizeConfigValue(setting.key, config, context)]),
  );
  return values as MuximodCanonicalConfig;
}

/** Creates a non-blocking status reader bound to the startup configuration. */
export function createMuximodConfigurationStatusReader(options: {
  configFile: string;
  startupConfig: MuximoConfig;
  resolution: MuximodConfigResolutionContext;
}): () => MuximodConfigurationStatus {
  const startupCanonical = canonicalizeMuximoConfig(options.startupConfig, options.resolution);
  return () => {
    try {
      const currentConfig = readMuximoConfig(options.configFile);
      const currentCanonical = canonicalizeMuximoConfig(currentConfig, options.resolution);
      const changedKeys = muximoConfigSettings
        .map((setting) => setting.key)
        .filter((key) => !configValuesEqual(startupCanonical[key], currentCanonical[key]));
      return changedKeys.length === 0
        ? { state: "current", changedKeys: [] }
        : { state: "restart_recommended", changedKeys };
    } catch {
      // Configuration diagnostics must never affect serving, command execution,
      // or shutdown cleanup. The daemon keeps using its startup snapshot.
      return { state: "unavailable", changedKeys: [] };
    }
  };
}

function canonicalizeConfigValue(
  key: MuximoConfigKey,
  config: MuximoConfig,
  context: MuximodConfigResolutionContext,
): MuximoConfigValue {
  const value = getMuximoConfigValue(config, key);
  if (key === "workspace.roots") {
    // An empty roots list means the daemon's home boundary. Keep the logical
    // config value empty so HOME remains launch metadata, not config identity.
    if (!Array.isArray(value)) throw new Error("workspace.roots must be an array");
    return value.length === 0 ? [] : value.map((root) => resolveMuximodConfiguredPath(root, context));
  }
  if (isExecutableKey(key)) {
    if (value === null) return null;
    if (typeof value !== "string") throw new Error(`${key} must be a string or null`);
    const executable = resolveMuximodConfiguredExecutable(value, context);
    return isAgentExecutableKey(key) && executable === defaultAgentExecutable(key) ? null : executable;
  }
  return copyConfigValue(value);
}

function isExecutableKey(key: MuximoConfigKey): boolean {
  return (
    key === "agents.executables.codex" ||
    key === "agents.executables.claude" ||
    key === "agents.executables.opencode" ||
    key === "serve.tailscale.executable"
  );
}

function isAgentExecutableKey(key: MuximoConfigKey): boolean {
  return (
    key === "agents.executables.codex" || key === "agents.executables.claude" || key === "agents.executables.opencode"
  );
}

function defaultAgentExecutable(key: MuximoConfigKey): string | undefined {
  switch (key) {
    case "agents.executables.codex":
      return "codex";
    case "agents.executables.claude":
      return "claude";
    case "agents.executables.opencode":
      return "opencode";
    default:
      return undefined;
  }
}

function copyConfigValue(value: MuximoConfigValue): MuximoConfigValue {
  return Array.isArray(value) ? [...value] : value;
}

function configValuesEqual(left: MuximoConfigValue, right: MuximoConfigValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
}
