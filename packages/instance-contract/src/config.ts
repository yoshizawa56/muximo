import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLoopbackOrPrivateBindHost } from "./paths.js";

export const muximoConfigFileName = "config.json";
export const muximoConfigVersion = 1;
export const muximoAgentBackends = ["codex", "claude", "opencode"] as const;
export const muximoUpdatePolicies = ["manual", "notify", "auto"] as const;
export const muximoUpdateChannels = ["stable"] as const;
export const muximoLogLevels = ["error", "warn", "info", "debug"] as const;
export const muximoSchemaModes = ["migrate", "push"] as const;

export type MuximoConfig = {
  version: typeof muximoConfigVersion;
  daemon: {
    host: string;
    port: number;
    allowedOrigins: string[];
  };
  logging: {
    level: MuximoLogLevel;
  };
  database: {
    schemaMode: MuximoSchemaMode;
  };
  workspace: { roots: string[] };
  agents: {
    enabled: MuximoAgentBackend[];
    default: MuximoAgentBackend | null;
    executables: Partial<Record<MuximoAgentBackend, string>>;
    codexRemote: string;
    opencode: { serverUrl: string | null };
  };
  serve: {
    tailscale: {
      enabled: boolean;
      executable: string;
      args: string[];
      hostname: string | null;
      externalPort: number;
      path: string;
    };
  };
  updates: {
    policy: MuximoUpdatePolicy;
    channel: (typeof muximoUpdateChannels)[number];
  };
};
/**
 * A versioned, importable configuration profile. Omitted values are populated
 * from the product defaults; importing a profile never preserves the current
 * instance configuration.
 */
export type MuximoConfigProfile = {
  version: typeof muximoConfigVersion;
  daemon?: Partial<MuximoConfig["daemon"]>;
  logging?: Partial<MuximoConfig["logging"]>;
  database?: Partial<MuximoConfig["database"]>;
  workspace?: Partial<MuximoConfig["workspace"]>;
  agents?: {
    enabled?: MuximoAgentBackend[];
    default?: MuximoAgentBackend | null;
    executables?: Partial<Record<MuximoAgentBackend, string | null>>;
    codexRemote?: string;
    opencode?: Partial<MuximoConfig["agents"]["opencode"]>;
  };
  serve?: {
    tailscale?: Partial<MuximoConfig["serve"]["tailscale"]>;
  };
  updates?: Partial<MuximoConfig["updates"]>;
};
export type MuximoAgentBackend = (typeof muximoAgentBackends)[number];
export type MuximoUpdatePolicy = (typeof muximoUpdatePolicies)[number];
export type MuximoLogLevel = (typeof muximoLogLevels)[number];
export type MuximoSchemaMode = (typeof muximoSchemaModes)[number];
export type MuximoConfigValue = string | number | boolean | null | readonly string[];
export type MuximoConfigChange = {
  key: MuximoConfigKey;
  before: MuximoConfigValue;
  after: MuximoConfigValue;
};
export type MuximoConfigSettingValueKind =
  | "directory-list"
  | "agent-list"
  | "agent-or-none"
  | "executable"
  | "boolean"
  | "string-list"
  | "string-or-none"
  | "integer"
  | "string"
  | "choice";
export type MuximoConfigSettingDisplayFormat = "comma-separated" | "json-array";
export type MuximoConfigSetting = {
  key: string;
  group: MuximoConfigSettingGroup;
  required?: boolean;
  condition?: MuximoConfigSettingCondition;
  description: string;
  valueDescription: string;
  valueKind: MuximoConfigSettingValueKind;
  displayFormat?: MuximoConfigSettingDisplayFormat;
  choices?: readonly string[];
  example?: string;
};
export type MuximoConfigSettingGroup = "daemon" | "logging" | "database" | "workspace" | "agents" | "serve" | "updates";
export type MuximoConfigSettingGroupMode = "optional" | "required" | "toggle";
export type MuximoConfigSettingCondition =
  | { key: string; operator: "equals"; value: boolean | number | string | null }
  | { key: string; operator: "includes"; value: string };
export type MuximoConfigSettingGroupDefinition = {
  key: MuximoConfigSettingGroup;
  description: string;
  mode: MuximoConfigSettingGroupMode;
  activationKey?: string;
};

export const muximoConfigSettingGroups = [
  { key: "daemon", description: "Daemon network access", mode: "optional" },
  { key: "logging", description: "Daemon logging", mode: "optional" },
  { key: "database", description: "Database schema", mode: "optional" },
  { key: "workspace", description: "Workspace discovery", mode: "optional" },
  { key: "agents", description: "Agent backends", mode: "optional" },
  {
    key: "serve",
    description: "Tailscale Serve",
    mode: "toggle",
    activationKey: "serve.tailscale.enabled",
  },
  { key: "updates", description: "Update behavior", mode: "optional" },
] as const satisfies readonly MuximoConfigSettingGroupDefinition[];

/** The single source of truth for config key documentation and completion metadata. */
export const muximoConfigSettings = [
  {
    key: "daemon.host",
    group: "daemon",
    description: "Local host address where muximod listens.",
    valueDescription: "localhost, a loopback address, or a private IP address",
    valueKind: "string",
    example: "127.0.0.1",
  },
  {
    key: "daemon.port",
    group: "daemon",
    description: "Local TCP port where muximod listens.",
    valueDescription: "an integer from 1 to 65535",
    valueKind: "integer",
    example: "4317",
  },
  {
    key: "daemon.allowedOrigins",
    group: "daemon",
    description: "Browser origins allowed to call muximod.",
    valueDescription: "comma-separated HTTP(S) origins or a JSON array of origins",
    valueKind: "string-list",
    example: "https://example.ts.net:8449,http://127.0.0.1:5227",
  },
  {
    key: "logging.level",
    group: "logging",
    description: "Minimum log level written by muximod.",
    valueDescription: "error, warn, info, or debug",
    valueKind: "choice",
    choices: muximoLogLevels,
    example: "info",
  },
  {
    key: "database.schemaMode",
    group: "database",
    description: "Database schema synchronization mode used at startup.",
    valueDescription: "migrate or push",
    valueKind: "choice",
    choices: muximoSchemaModes,
    example: "migrate",
  },
  {
    key: "workspace.roots",
    group: "workspace",
    description: "Directories searched for available workspaces.",
    valueDescription: "comma-separated directories or a JSON array of directories",
    valueKind: "directory-list",
    example: "~/work/project,~/work/other",
  },
  {
    key: "agents.enabled",
    group: "agents",
    description: "Agent backends exposed to the daemon and connected clients.",
    valueDescription: "comma-separated backend names; leave empty to disable agent backends",
    valueKind: "agent-list",
    choices: muximoAgentBackends,
    example: "codex,claude",
  },
  {
    key: "agents.default",
    group: "agents",
    description: "Backend selected when a session does not specify one.",
    valueDescription: "one enabled backend name or none",
    valueKind: "agent-or-none",
    choices: [...muximoAgentBackends, "none"] as const,
    example: "claude",
  },
  {
    key: "agents.codexRemote",
    group: "agents",
    condition: { key: "agents.enabled", operator: "includes", value: "codex" },
    description: "Default Codex remote endpoint used by the daemon.",
    valueDescription: "a Codex remote endpoint such as unix://",
    valueKind: "string",
    example: "unix://",
  },
  {
    key: "agents.executables.codex",
    group: "agents",
    condition: { key: "agents.enabled", operator: "includes", value: "codex" },
    description: "Codex executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/codex",
  },
  {
    key: "agents.executables.claude",
    group: "agents",
    condition: { key: "agents.enabled", operator: "includes", value: "claude" },
    description: "Claude executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/claude",
  },
  {
    key: "agents.executables.opencode",
    group: "agents",
    condition: { key: "agents.enabled", operator: "includes", value: "opencode" },
    description: "OpenCode executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/opencode",
  },
  {
    key: "agents.opencode.serverUrl",
    group: "agents",
    condition: { key: "agents.enabled", operator: "includes", value: "opencode" },
    description: "External OpenCode server URL used instead of bootstrapping a local server.",
    valueDescription: "a local http://127.0.0.1 URL or none to bootstrap locally",
    valueKind: "string-or-none",
    example: "http://127.0.0.1:4096",
  },
  {
    key: "serve.tailscale.enabled",
    group: "serve",
    description: "Allow muximo to manage its Tailscale Serve route.",
    valueDescription: "true or false",
    valueKind: "boolean",
    example: "true",
  },
  {
    key: "serve.tailscale.executable",
    group: "serve",
    condition: { key: "serve.tailscale.enabled", operator: "equals", value: true },
    description: "Tailscale executable used for Serve operations.",
    valueDescription: "an executable name or filesystem path",
    valueKind: "executable",
    example: "/usr/local/bin/tailscale",
  },
  {
    key: "serve.tailscale.args",
    group: "serve",
    condition: { key: "serve.tailscale.enabled", operator: "equals", value: true },
    description: "Arguments prepended to every Tailscale invocation.",
    valueDescription: "comma-separated arguments or a JSON array of strings",
    valueKind: "string-list",
    displayFormat: "json-array",
    example: '["--socket", "/run/user/1000/tailscaled.sock"]',
  },
  {
    key: "serve.tailscale.hostname",
    group: "serve",
    condition: { key: "serve.tailscale.enabled", operator: "equals", value: true },
    description: "Tailscale hostname used for the Serve route.",
    valueDescription: "a hostname or none to discover it automatically",
    valueKind: "string-or-none",
    example: "host.example.ts.net",
  },
  {
    key: "serve.tailscale.externalPort",
    group: "serve",
    condition: { key: "serve.tailscale.enabled", operator: "equals", value: true },
    description: "External port used by the Tailscale Serve route.",
    valueDescription: "an integer from 1 to 65535",
    valueKind: "integer",
    example: "8444",
  },
  {
    key: "serve.tailscale.path",
    group: "serve",
    condition: { key: "serve.tailscale.enabled", operator: "equals", value: true },
    description: "HTTP path mounted by the Tailscale Serve route.",
    valueDescription: "a URL path such as /",
    valueKind: "string",
    example: "/",
  },
  {
    key: "updates.policy",
    group: "updates",
    description: "How muximo should handle available releases.",
    valueDescription: "manual, notify, or auto",
    valueKind: "choice",
    choices: muximoUpdatePolicies,
    example: "notify",
  },
  {
    key: "updates.channel",
    group: "updates",
    description: "Release channel used for update checks.",
    valueDescription: "stable",
    valueKind: "choice",
    choices: muximoUpdateChannels,
    example: "stable",
  },
] as const satisfies readonly MuximoConfigSetting[];
export type MuximoConfigKey = (typeof muximoConfigSettings)[number]["key"];
export const muximoConfigKeys = muximoConfigSettings.map((setting) => setting.key) as MuximoConfigKey[];

export function getMuximoConfigSetting(key: string): MuximoConfigSetting | undefined {
  return muximoConfigSettings.find((setting) => setting.key === key);
}

export function getMuximoConfigSettingGroup(group: string): MuximoConfigSettingGroupDefinition | undefined {
  return muximoConfigSettingGroups.find((candidate) => candidate.key === group);
}

export function formatMuximoConfigValue(key: string, value: MuximoConfigValue): string {
  const setting = requireMuximoConfigSetting(key);
  if (value === null) return "none";
  if (Array.isArray(value)) return setting.displayFormat === "json-array" ? JSON.stringify(value) : value.join(", ");
  return String(value);
}

export function muximoConfigSettingsForGroup(
  config: MuximoConfig,
  group: MuximoConfigSettingGroup,
): readonly MuximoConfigSetting[] {
  return muximoConfigSettings.filter(
    (setting) => setting.group === group && isMuximoConfigSettingApplicable(config, setting),
  );
}

export function isMuximoConfigSettingApplicable(config: MuximoConfig, setting: MuximoConfigSetting): boolean {
  const condition = setting.condition;
  if (condition === undefined) return true;
  const value = getMuximoConfigValue(config, condition.key);
  if (condition.operator === "equals") return value === condition.value;
  return Array.isArray(value) && value.includes(condition.value);
}

export function defaultMuximoConfig(): MuximoConfig {
  return {
    version: muximoConfigVersion,
    daemon: {
      host: "127.0.0.1",
      port: 4317,
      allowedOrigins: [],
    },
    logging: { level: "info" },
    database: { schemaMode: "migrate" },
    workspace: { roots: [] },
    agents: {
      enabled: [],
      default: null,
      executables: {},
      codexRemote: "unix://",
      opencode: { serverUrl: null },
    },
    serve: {
      tailscale: {
        enabled: false,
        executable: "tailscale",
        args: [],
        hostname: null,
        externalPort: 8444,
        path: "/",
      },
    },
    updates: {
      policy: "manual",
      channel: "stable",
    },
  };
}

export function diffMuximoConfig(before: MuximoConfig, after: MuximoConfig): MuximoConfigChange[] {
  return muximoConfigSettings.flatMap((setting) => {
    const beforeValue = getMuximoConfigValue(before, setting.key);
    const afterValue = getMuximoConfigValue(after, setting.key);
    return configValuesEqual(beforeValue, afterValue)
      ? []
      : [{ key: setting.key, before: beforeValue, after: afterValue } satisfies MuximoConfigChange];
  });
}

export function muximoConfigPath(instanceDirectory: string): string {
  return join(instanceDirectory, muximoConfigFileName);
}

export function readMuximoConfig(filePath: string): MuximoConfig {
  if (!existsSync(filePath)) return defaultMuximoConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read muximo config ${filePath}`, { cause: error });
  }
  try {
    return validateMuximoConfig(parsed);
  } catch (error) {
    throw new Error(`invalid muximo config ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Reads an importable profile and materializes it as a complete configuration. */
export function readMuximoConfigProfile(filePath: string): MuximoConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read muximo config profile ${filePath}`, { cause: error });
  }
  try {
    return normalizeMuximoConfigProfile(parsed);
  } catch (error) {
    throw new Error(`invalid muximo config profile ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Writes the instance configuration with permissions suitable for local user settings. */
export function writeMuximoConfig(filePath: string, config: MuximoConfig): void {
  const validated = validateMuximoConfig(config);
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original write failure.
    }
    throw new Error(`could not write muximo config ${filePath}`, { cause: error });
  }
}

export function getMuximoConfigValue(config: MuximoConfig, key: string): MuximoConfigValue {
  requireMuximoConfigSetting(key);
  switch (key) {
    case "daemon.host":
      return config.daemon.host;
    case "daemon.port":
      return config.daemon.port;
    case "daemon.allowedOrigins":
      return config.daemon.allowedOrigins;
    case "logging.level":
      return config.logging.level;
    case "database.schemaMode":
      return config.database.schemaMode;
    case "workspace.roots":
      return config.workspace.roots;
    case "agents.enabled":
      return config.agents.enabled;
    case "agents.default":
      return config.agents.default;
    case "agents.codexRemote":
      return config.agents.codexRemote;
    case "agents.executables.codex":
      return config.agents.executables.codex ?? null;
    case "agents.executables.claude":
      return config.agents.executables.claude ?? null;
    case "agents.executables.opencode":
      return config.agents.executables.opencode ?? null;
    case "agents.opencode.serverUrl":
      return config.agents.opencode.serverUrl;
    case "serve.tailscale.enabled":
      return config.serve.tailscale.enabled;
    case "serve.tailscale.executable":
      return config.serve.tailscale.executable;
    case "serve.tailscale.args":
      return config.serve.tailscale.args;
    case "serve.tailscale.hostname":
      return config.serve.tailscale.hostname;
    case "serve.tailscale.externalPort":
      return config.serve.tailscale.externalPort;
    case "serve.tailscale.path":
      return config.serve.tailscale.path;
    case "updates.policy":
      return config.updates.policy;
    case "updates.channel":
      return config.updates.channel;
    default:
      throw new Error(`unsupported muximo config key: ${key}`);
  }
}

export function parseMuximoConfigValue(key: string, rawValues: readonly string[]): MuximoConfigValue {
  const setting = requireMuximoConfigSetting(key);
  if (rawValues.length === 0) throw new Error(`a value is required for muximo config key: ${key}`);
  const arrayKey =
    setting.valueKind === "directory-list" || setting.valueKind === "agent-list" || setting.valueKind === "string-list";
  if (arrayKey) {
    if (rawValues.length > 1) return rawValues;
    const raw = rawValues[0].trim();
    if (raw.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
          throw new Error("expected a JSON array of strings");
        }
        return parsed;
      } catch (error) {
        throw new Error(`invalid array value for ${key}`, { cause: error });
      }
    }
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (rawValues.length > 1) throw new Error(`only one value is allowed for muximo config key: ${key}`);
  const raw = rawValues[0].trim();
  if (raw === "null" || raw === "none") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^[0-9]+$/u.test(raw)) return Number(raw);
  return raw;
}

export function setMuximoConfigValue(config: MuximoConfig, key: string, value: MuximoConfigValue): MuximoConfig {
  requireMuximoConfigSetting(key);
  const next = structuredClone(config);
  switch (key) {
    case "daemon.host":
      next.daemon.host = requireHost(key, value);
      break;
    case "daemon.port":
      next.daemon.port = requirePort(key, value);
      break;
    case "daemon.allowedOrigins":
      next.daemon.allowedOrigins = requireOriginArray(key, value);
      break;
    case "logging.level":
      next.logging.level = requireChoice(key, value, muximoLogLevels);
      break;
    case "database.schemaMode":
      next.database.schemaMode = requireChoice(key, value, muximoSchemaModes);
      break;
    case "workspace.roots":
      next.workspace.roots = requireStringArray(key, value, true);
      break;
    case "agents.enabled":
      next.agents.enabled = requireAgentArray(key, value);
      if (next.agents.default !== null && !next.agents.enabled.includes(next.agents.default))
        next.agents.default = null;
      break;
    case "agents.default":
      next.agents.default = requireAgentOrNull(key, value);
      break;
    case "agents.codexRemote":
      next.agents.codexRemote = requireString(key, value);
      break;
    case "agents.executables.codex":
      setExecutable(next, "codex", value);
      break;
    case "agents.executables.claude":
      setExecutable(next, "claude", value);
      break;
    case "agents.executables.opencode":
      setExecutable(next, "opencode", value);
      break;
    case "agents.opencode.serverUrl":
      next.agents.opencode.serverUrl = value === null ? null : requireString(key, value);
      break;
    case "serve.tailscale.enabled":
      next.serve.tailscale.enabled = requireBoolean(key, value);
      break;
    case "serve.tailscale.executable":
      next.serve.tailscale.executable = requireString(key, value);
      break;
    case "serve.tailscale.args":
      next.serve.tailscale.args = requireStringArray(key, value, true);
      break;
    case "serve.tailscale.hostname":
      next.serve.tailscale.hostname = value === null ? null : requireString(key, value);
      break;
    case "serve.tailscale.externalPort":
      next.serve.tailscale.externalPort = requirePort(key, value);
      break;
    case "serve.tailscale.path":
      next.serve.tailscale.path = requireString(key, value);
      break;
    case "updates.policy":
      next.updates.policy = requireChoice(key, value, muximoUpdatePolicies);
      break;
    case "updates.channel":
      next.updates.channel = requireChoice(key, value, muximoUpdateChannels);
      break;
    default:
      throw new Error(`unsupported muximo config key: ${key}`);
  }
  return validateMuximoConfig(next);
}

function setExecutable(config: MuximoConfig, backend: MuximoAgentBackend, value: MuximoConfigValue): void {
  if (value === null) delete config.agents.executables[backend];
  else config.agents.executables[backend] = requireString(`agents.executables.${backend}`, value);
}

function requireStringArray(key: string, value: unknown, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || (allowEmpty && item.length === 0) || item.trim().length === 0)
  ) {
    throw new Error(`${key} must be a string array`);
  }
  return value.map((item) => item.trim());
}

function requireAgentArray(key: string, value: unknown): MuximoAgentBackend[] {
  const values = requireStringArray(key, value, true);
  if (values.some((item) => !(muximoAgentBackends as readonly string[]).includes(item))) {
    throw new Error(`${key} contains an unsupported agent backend`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${key} must not contain duplicate agent backends`);
  return values as MuximoAgentBackend[];
}

function requireString(key: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

function requireBoolean(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`${key} must be true or false`);
  return value;
}

function requireNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function requirePort(key: string, value: unknown): number {
  const port = requireNumber(key, value);
  if (port < 1 || port > 65_535) throw new Error(`${key} must be between 1 and 65535`);
  return port;
}

function requireHost(key: string, value: unknown): string {
  const host = requireString(key, value);
  if (!isLoopbackOrPrivateBindHost(host)) {
    throw new Error(`${key} must be localhost, a loopback address, or a private IP address`);
  }
  return host;
}

function requireOriginArray(key: string, value: unknown): string[] {
  const origins = requireStringArray(key, value, true);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${key} contains an invalid URL`);
    }
    if (
      parsed.origin !== origin ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(`${key} must contain HTTP(S) origins without credentials`);
    }
  }
  return origins;
}

function requireOpenCodeServerUrl(key: string, value: unknown): string {
  const serverUrl = requireString(key, value);
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    !parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${key} must use an unauthenticated http://127.0.0.1 URL with a port and no path or query`);
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${key} has an invalid port`);
  return serverUrl;
}

function requireTailscaleHostname(key: string, value: unknown): string {
  const hostname = requireString(key, value);
  const normalized = hostname.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  if (!normalized) throw new Error(`${key} must be a hostname`);
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw new Error(`${key} must be a valid hostname`);
  }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${key} must be a hostname without credentials, a port, or a path`);
  }
  return hostname;
}

function requireAgentOrNull(key: string, value: unknown): MuximoAgentBackend | null {
  if (value === null) return null;
  if (typeof value !== "string" || !(muximoAgentBackends as readonly string[]).includes(value)) {
    throw new Error(`${key} must be an agent backend or null`);
  }
  return value as MuximoAgentBackend;
}

function requireChoice<T extends string>(key: string, value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new Error(`${key} has an unsupported value`);
  return value as T;
}

function validateMuximoConfig(value: unknown): MuximoConfig {
  if (!isRecord(value)) throw new Error("configuration must be an object");
  assertKeys(
    value,
    ["version", "daemon", "logging", "database", "workspace", "agents", "serve", "updates"],
    "configuration",
  );
  if (value.version !== muximoConfigVersion) throw new Error(`version must be ${muximoConfigVersion}`);
  const daemon = requireRecord(value.daemon, "daemon");
  const logging = requireRecord(value.logging, "logging");
  const database = requireRecord(value.database, "database");
  const workspace = requireRecord(value.workspace, "workspace");
  const agents = requireRecord(value.agents, "agents");
  const executables = requireRecord(agents.executables, "agents.executables");
  const opencode = requireRecord(agents.opencode, "agents.opencode");
  const serve = requireRecord(value.serve, "serve");
  const tailscale = requireRecord(serve.tailscale, "serve.tailscale");
  const updates = requireRecord(value.updates, "updates");
  assertKeys(daemon, ["host", "port", "allowedOrigins"], "daemon");
  assertKeys(logging, ["level"], "logging");
  assertKeys(database, ["schemaMode"], "database");
  assertKeys(workspace, ["roots"], "workspace");
  assertKeys(agents, ["enabled", "default", "executables", "codexRemote", "opencode"], "agents");
  assertKeys(executables, muximoAgentBackends, "agents.executables");
  assertKeys(opencode, ["serverUrl"], "agents.opencode");
  assertKeys(serve, ["tailscale"], "serve");
  assertKeys(tailscale, ["enabled", "executable", "args", "hostname", "externalPort", "path"], "serve.tailscale");
  assertKeys(updates, ["policy", "channel"], "updates");
  const enabled = requireAgentArray("agents.enabled", agents.enabled);
  const defaultBackend = agents.default === null ? null : requireAgentOrNull("agents.default", agents.default);
  if (defaultBackend !== null && !enabled.includes(defaultBackend)) {
    throw new Error("agents.default must be enabled");
  }
  const validatedExecutables: Partial<Record<MuximoAgentBackend, string>> = {};
  for (const backend of muximoAgentBackends) {
    const executable = executables[backend];
    if (executable !== undefined)
      validatedExecutables[backend] = requireString(`agents.executables.${backend}`, executable);
  }
  const opencodeServerUrl =
    opencode.serverUrl === null ? null : requireOpenCodeServerUrl("agents.opencode.serverUrl", opencode.serverUrl);
  const args = requireStringArray("serve.tailscale.args", tailscale.args, true);
  const hostname =
    tailscale.hostname === null ? null : requireTailscaleHostname("serve.tailscale.hostname", tailscale.hostname);
  const externalPort = requirePort("serve.tailscale.externalPort", tailscale.externalPort);
  return {
    version: muximoConfigVersion,
    daemon: {
      host: requireHost("daemon.host", daemon.host),
      port: requirePort("daemon.port", daemon.port),
      allowedOrigins: requireOriginArray("daemon.allowedOrigins", daemon.allowedOrigins),
    },
    logging: {
      level: requireChoice("logging.level", logging.level, muximoLogLevels),
    },
    database: {
      schemaMode: requireChoice("database.schemaMode", database.schemaMode, muximoSchemaModes),
    },
    workspace: { roots: requireStringArray("workspace.roots", workspace.roots, true) },
    agents: {
      enabled,
      default: defaultBackend,
      executables: validatedExecutables,
      codexRemote: requireString("agents.codexRemote", agents.codexRemote),
      opencode: { serverUrl: opencodeServerUrl },
    },
    serve: {
      tailscale: {
        enabled: requireBoolean("serve.tailscale.enabled", tailscale.enabled),
        executable: requireString("serve.tailscale.executable", tailscale.executable),
        args,
        hostname,
        externalPort,
        path: requireString("serve.tailscale.path", tailscale.path),
      },
    },
    updates: {
      policy: requireChoice("updates.policy", updates.policy, muximoUpdatePolicies),
      channel: requireChoice("updates.channel", updates.channel, muximoUpdateChannels),
    },
  };
}

function normalizeMuximoConfigProfile(value: unknown): MuximoConfig {
  const profile = requireRecord(value, "configuration profile");
  assertKeys(
    profile,
    ["version", "daemon", "logging", "database", "workspace", "agents", "serve", "updates"],
    "configuration profile",
  );
  if (profile.version !== muximoConfigVersion) throw new Error(`version must be ${muximoConfigVersion}`);
  assertOptionalRecordKeys(profile, "daemon", ["host", "port", "allowedOrigins"]);
  assertOptionalRecordKeys(profile, "logging", ["level"]);
  assertOptionalRecordKeys(profile, "database", ["schemaMode"]);
  assertOptionalRecordKeys(profile, "workspace", ["roots"]);
  assertOptionalRecordKeys(profile, "agents", ["enabled", "default", "executables", "codexRemote", "opencode"]);
  if (isRecord(profile.agents)) {
    assertOptionalRecordKeys(profile.agents, "executables", muximoAgentBackends);
    assertOptionalRecordKeys(profile.agents, "opencode", ["serverUrl"]);
  }
  assertOptionalRecordKeys(profile, "serve", ["tailscale"]);
  if (isRecord(profile.serve)) {
    assertOptionalRecordKeys(profile.serve, "tailscale", [
      "enabled",
      "executable",
      "args",
      "hostname",
      "externalPort",
      "path",
    ]);
  }
  assertOptionalRecordKeys(profile, "updates", ["policy", "channel"]);

  let config = defaultMuximoConfig();
  for (const setting of muximoConfigSettings) {
    const valueAtKey = readProfileValue(profile, setting.key);
    if (valueAtKey.present) {
      config = setMuximoConfigValue(config, setting.key, valueAtKey.value as MuximoConfigValue);
    }
  }
  return config;
}

function assertOptionalRecordKeys(parent: Record<string, unknown>, key: string, allowed: readonly string[]): void {
  if (!Object.hasOwn(parent, key)) return;
  const value = parent[key];
  if (!isRecord(value)) throw new Error(`${key} must be an object`);
  assertKeys(value, allowed, key);
}

function readProfileValue(value: Record<string, unknown>, key: string): { present: boolean; value?: unknown } {
  let current: unknown = value;
  for (const segment of key.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
    current = current[segment];
  }
  return { present: true, value: current };
}

function requireRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${key} must be an object`);
  return value;
}

function requireMuximoConfigSetting(key: string): MuximoConfigSetting {
  const setting = getMuximoConfigSetting(key);
  if (setting === undefined) throw new Error(`unsupported muximo config key: ${key}`);
  return setting;
}

function configValuesEqual(left: MuximoConfigValue, right: MuximoConfigValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], key: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((candidate) => !allowedKeys.has(candidate));
  if (unknown !== undefined) throw new Error(`${key}.${unknown} is not supported`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
