import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isLoopbackOrPrivateBindHost } from "./paths.js";

export const muximoConfigFileName = "config.json";
export const muximoConfigVersion = 1;
export const muximoAgentBackends = ["codex", "claude", "opencode"] as const;
export const muximoUpdatePolicies = ["manual", "notify", "auto"] as const;
export const muximoUpdateChannels = ["stable"] as const;
export const muximoLogLevels = ["error", "warn", "info", "debug"] as const;
export const muximoSchemaModes = ["migrate", "push"] as const;

export type MuximoAgentBackend = (typeof muximoAgentBackends)[number];
export type MuximoUpdatePolicy = (typeof muximoUpdatePolicies)[number];
export type MuximoLogLevel = (typeof muximoLogLevels)[number];
export type MuximoSchemaMode = (typeof muximoSchemaModes)[number];
export type MuximoConfigValue = string | number | boolean | null | readonly string[];

const nonEmptyStringSchema = z.string().trim().min(1);
const portSchema = z.number().int().min(1).max(65_535);
const agentBackendSchema = z.enum(muximoAgentBackends);
const updatePolicySchema = z.enum(muximoUpdatePolicies);
const updateChannelSchema = z.enum(muximoUpdateChannels);
const logLevelSchema = z.enum(muximoLogLevels);
const schemaModeSchema = z.enum(muximoSchemaModes);

const daemonConfigSchema = z
  .object({
    host: nonEmptyStringSchema
      .refine(isLoopbackOrPrivateBindHost, "host must be localhost, a loopback address, or a private IP address")
      .default("127.0.0.1"),
    port: portSchema.default(4317),
    allowedOrigins: z
      .array(nonEmptyStringSchema.refine(isAllowedOrigin, "must be an exact HTTP(S) origin without credentials"))
      .default([]),
  })
  .strict()
  .prefault({});

const agentExecutablesSchema = z
  .object({
    codex: nonEmptyStringSchema.nullable().optional(),
    claude: nonEmptyStringSchema.nullable().optional(),
    opencode: nonEmptyStringSchema.nullable().optional(),
  })
  .strict()
  .prefault({})
  .transform((executables) => {
    const normalized: Partial<Record<MuximoAgentBackend, string>> = {};
    for (const backend of muximoAgentBackends) {
      const executable = executables[backend];
      if (executable !== undefined && executable !== null) normalized[backend] = executable;
    }
    return normalized;
  });

const agentsConfigSchema = z
  .object({
    enabled: z
      .array(agentBackendSchema)
      .superRefine((enabled, context) => {
        if (new Set(enabled).size !== enabled.length) {
          context.addIssue({ code: "custom", message: "must not contain duplicate agent backends" });
        }
      })
      .default([]),
    default: agentBackendSchema.nullable().default(null),
    executables: agentExecutablesSchema,
    codexRemote: nonEmptyStringSchema.default("unix://"),
    opencode: z
      .object({
        serverUrl: z
          .union([
            z.null(),
            nonEmptyStringSchema.refine(
              isOpenCodeServerUrl,
              "must use an unauthenticated http://127.0.0.1 URL with a port and no path or query",
            ),
          ])
          .default(null),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((agents, context) => {
    if (agents.default !== null && !agents.enabled.includes(agents.default)) {
      context.addIssue({ code: "custom", path: ["default"], message: "must be enabled" });
    }
  })
  .prefault({});

const tailscaleConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    executable: nonEmptyStringSchema.default("tailscale"),
    args: z.array(nonEmptyStringSchema).default([]),
    hostname: z
      .union([
        z.null(),
        nonEmptyStringSchema.refine(isTailscaleHostname, "must be a hostname without credentials, a port, or a path"),
      ])
      .default(null),
    externalPort: portSchema.default(8444),
    path: nonEmptyStringSchema.default("/"),
  })
  .strict()
  .prefault({});

export const muximoConfigSchema = z
  .object({
    version: z.literal(muximoConfigVersion),
    daemon: daemonConfigSchema,
    logging: z
      .object({ level: logLevelSchema.default("info") })
      .strict()
      .prefault({}),
    database: z
      .object({ schemaMode: schemaModeSchema.default("migrate") })
      .strict()
      .prefault({}),
    workspace: z
      .object({ roots: z.array(nonEmptyStringSchema).default([]) })
      .strict()
      .prefault({}),
    agents: agentsConfigSchema,
    serve: z.object({ tailscale: tailscaleConfigSchema }).strict().prefault({}),
    web: z
      .object({
        proxy: z
          .object({
            enabled: z.boolean().default(false),
            host: nonEmptyStringSchema
              .refine(isLoopbackHost, "host must be localhost, 127.0.0.1, or ::1")
              .default("127.0.0.1"),
            port: portSchema.default(5227),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    updates: z
      .object({
        policy: updatePolicySchema.default("manual"),
        channel: updateChannelSchema.default("stable"),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type MuximoConfig = z.output<typeof muximoConfigSchema>;
/** A versioned configuration document. Omitted settings use schema defaults. */
export type MuximoConfigProfile = z.input<typeof muximoConfigSchema>;

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
export type MuximoConfigSettingGroup =
  | "daemon"
  | "logging"
  | "database"
  | "workspace"
  | "agents"
  | "serve"
  | "web"
  | "updates";
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
  { key: "web", description: "Web development proxy", mode: "toggle", activationKey: "web.proxy.enabled" },
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
    example: "https://example.ts.net:8449,http://127.0.0.1:4317",
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
    key: "web.proxy.enabled",
    group: "web",
    description: "Start a Vite Web server and proxy it through muximod.",
    valueDescription: "true or false",
    valueKind: "boolean",
    example: "true",
  },
  {
    key: "web.proxy.host",
    group: "web",
    condition: { key: "web.proxy.enabled", operator: "equals", value: true },
    description: "Loopback host where the Vite Web server listens.",
    valueDescription: "localhost, 127.0.0.1, or ::1",
    valueKind: "string",
    example: "127.0.0.1",
  },
  {
    key: "web.proxy.port",
    group: "web",
    condition: { key: "web.proxy.enabled", operator: "equals", value: true },
    description: "Local port where the Vite Web server listens.",
    valueDescription: "an integer from 1 to 65535",
    valueKind: "integer",
    example: "5227",
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
  return parseMuximoConfig({ version: muximoConfigVersion });
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
    return parseMuximoConfig(parsed);
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
    return parseMuximoConfig(parsed);
  } catch (error) {
    throw new Error(`invalid muximo config profile ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}

/** Writes the instance configuration with permissions suitable for local user settings. */
export function writeMuximoConfig(filePath: string, config: MuximoConfig): void {
  const validated = parseMuximoConfig(config);
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
    case "web.proxy.enabled":
      return config.web.proxy.enabled;
    case "web.proxy.host":
      return config.web.proxy.host;
    case "web.proxy.port":
      return config.web.proxy.port;
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
      next.daemon.host = value as string;
      break;
    case "daemon.port":
      next.daemon.port = value as number;
      break;
    case "daemon.allowedOrigins":
      next.daemon.allowedOrigins = value as string[];
      break;
    case "logging.level":
      next.logging.level = value as MuximoLogLevel;
      break;
    case "database.schemaMode":
      next.database.schemaMode = value as MuximoSchemaMode;
      break;
    case "workspace.roots":
      next.workspace.roots = value as string[];
      break;
    case "agents.enabled":
      next.agents.enabled = value as MuximoAgentBackend[];
      if (
        Array.isArray(next.agents.enabled) &&
        next.agents.default !== null &&
        !next.agents.enabled.includes(next.agents.default)
      )
        next.agents.default = null;
      break;
    case "agents.default":
      next.agents.default = value as MuximoAgentBackend | null;
      break;
    case "agents.codexRemote":
      next.agents.codexRemote = value as string;
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
      next.agents.opencode.serverUrl = value as string | null;
      break;
    case "serve.tailscale.enabled":
      next.serve.tailscale.enabled = value as boolean;
      break;
    case "serve.tailscale.executable":
      next.serve.tailscale.executable = value as string;
      break;
    case "serve.tailscale.args":
      next.serve.tailscale.args = value as string[];
      break;
    case "serve.tailscale.hostname":
      next.serve.tailscale.hostname = value as string | null;
      break;
    case "serve.tailscale.externalPort":
      next.serve.tailscale.externalPort = value as number;
      break;
    case "serve.tailscale.path":
      next.serve.tailscale.path = value as string;
      break;
    case "web.proxy.enabled":
      next.web.proxy.enabled = value as boolean;
      break;
    case "web.proxy.host":
      next.web.proxy.host = value as string;
      break;
    case "web.proxy.port":
      next.web.proxy.port = value as number;
      break;
    case "updates.policy":
      next.updates.policy = value as MuximoUpdatePolicy;
      break;
    case "updates.channel":
      next.updates.channel = value as (typeof muximoUpdateChannels)[number];
      break;
    default:
      throw new Error(`unsupported muximo config key: ${key}`);
  }
  return parseMuximoConfig(next);
}

function setExecutable(config: MuximoConfig, backend: MuximoAgentBackend, value: MuximoConfigValue): void {
  if (value === null) delete config.agents.executables[backend];
  else config.agents.executables[backend] = value as string;
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

function parseMuximoConfig(value: unknown): MuximoConfig {
  try {
    return muximoConfigSchema.parse(value);
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

function isAllowedOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.origin === value &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username.length === 0 &&
    parsed.password.length === 0
  );
}

function isOpenCodeServerUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length === 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return false;
  }
  const port = Number.parseInt(parsed.port, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function isTailscaleHostname(value: string): boolean {
  const normalized = value.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  if (normalized.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    return false;
  }
  return (
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.port.length === 0 &&
    parsed.pathname === "/" &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  );
}

function isLoopbackHost(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (issue !== undefined) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "configuration";
      return `${path} ${issue.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
