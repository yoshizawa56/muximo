import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const muximoConfigFileName = "config.json";
export const muximoConfigVersion = 1;
export const muximoAgentBackends = ["codex", "claude", "opencode"] as const;
export const muximoUpdatePolicies = ["manual", "notify", "auto"] as const;
export const muximoUpdateChannels = ["stable"] as const;

export type MuximoConfig = {
  version: typeof muximoConfigVersion;
  workspace: { roots: string[] };
  agents: {
    enabled: MuximoAgentBackend[];
    default: MuximoAgentBackend | null;
    executables: Partial<Record<MuximoAgentBackend, string>>;
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
export type MuximoAgentBackend = (typeof muximoAgentBackends)[number];
export type MuximoUpdatePolicy = (typeof muximoUpdatePolicies)[number];
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
export type MuximoConfigSetting = {
  key: string;
  description: string;
  valueDescription: string;
  valueKind: MuximoConfigSettingValueKind;
  choices?: readonly string[];
  example?: string;
};

/** The single source of truth for config key documentation and completion metadata. */
export const muximoConfigSettings = [
  {
    key: "workspace.roots",
    description: "Directories searched for available workspaces.",
    valueDescription: "comma-separated directories or a JSON array of directories",
    valueKind: "directory-list",
    example: "~/work/project,~/work/other",
  },
  {
    key: "agents.enabled",
    description: "Agent backends exposed to the daemon and connected clients.",
    valueDescription: "comma-separated backend names; at least one is required",
    valueKind: "agent-list",
    choices: muximoAgentBackends,
    example: "codex,claude",
  },
  {
    key: "agents.default",
    description: "Backend selected when a session does not specify one.",
    valueDescription: "one enabled backend name or none",
    valueKind: "agent-or-none",
    choices: [...muximoAgentBackends, "none"] as const,
    example: "claude",
  },
  {
    key: "agents.executables.codex",
    description: "Codex executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/codex",
  },
  {
    key: "agents.executables.claude",
    description: "Claude executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/claude",
  },
  {
    key: "agents.executables.opencode",
    description: "OpenCode executable used to start provider sessions.",
    valueDescription: "an executable name or filesystem path; use none to clear it",
    valueKind: "executable",
    example: "~/.local/bin/opencode",
  },
  {
    key: "serve.tailscale.enabled",
    description: "Allow muximo to manage its Tailscale Serve route.",
    valueDescription: "true or false",
    valueKind: "boolean",
    example: "true",
  },
  {
    key: "serve.tailscale.executable",
    description: "Tailscale executable used for Serve operations.",
    valueDescription: "an executable name or filesystem path",
    valueKind: "executable",
    example: "/usr/local/bin/tailscale",
  },
  {
    key: "serve.tailscale.args",
    description: "Arguments prepended to every Tailscale invocation.",
    valueDescription: "comma-separated arguments or a JSON array of strings",
    valueKind: "string-list",
    example: '["--socket", "/run/user/1000/tailscaled.sock"]',
  },
  {
    key: "serve.tailscale.hostname",
    description: "Tailscale hostname used for the Serve route.",
    valueDescription: "a hostname or none to discover it automatically",
    valueKind: "string-or-none",
    example: "host.example.ts.net",
  },
  {
    key: "serve.tailscale.externalPort",
    description: "External port used by the Tailscale Serve route.",
    valueDescription: "an integer from 1 to 65535",
    valueKind: "integer",
    example: "8444",
  },
  {
    key: "serve.tailscale.path",
    description: "HTTP path mounted by the Tailscale Serve route.",
    valueDescription: "a URL path such as /",
    valueKind: "string",
    example: "/",
  },
  {
    key: "updates.policy",
    description: "How muximo should handle available releases.",
    valueDescription: "manual, notify, or auto",
    valueKind: "choice",
    choices: muximoUpdatePolicies,
    example: "notify",
  },
  {
    key: "updates.channel",
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

export function defaultTailscaleExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale" : "tailscale";
}

export function defaultMuximoConfig(platform: NodeJS.Platform = process.platform): MuximoConfig {
  return {
    version: muximoConfigVersion,
    workspace: { roots: [] },
    agents: {
      // Codex is the only required provider for the default installation.
      // Optional providers are enabled explicitly by the user.
      enabled: ["codex"],
      default: "codex",
      executables: {},
    },
    serve: {
      tailscale: {
        enabled: false,
        executable: defaultTailscaleExecutable(platform),
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
    case "workspace.roots":
      return config.workspace.roots;
    case "agents.enabled":
      return config.agents.enabled;
    case "agents.default":
      return config.agents.default;
    case "agents.executables.codex":
      return config.agents.executables.codex ?? null;
    case "agents.executables.claude":
      return config.agents.executables.claude ?? null;
    case "agents.executables.opencode":
      return config.agents.executables.opencode ?? null;
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
    case "agents.executables.codex":
      setExecutable(next, "codex", value);
      break;
    case "agents.executables.claude":
      setExecutable(next, "claude", value);
      break;
    case "agents.executables.opencode":
      setExecutable(next, "opencode", value);
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
      next.serve.tailscale.externalPort = requireNumber(key, value);
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
  if (values.length === 0) throw new Error(`${key} must contain at least one agent backend`);
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
  assertKeys(value, ["version", "workspace", "agents", "serve", "updates"], "configuration");
  if (value.version !== muximoConfigVersion) throw new Error(`version must be ${muximoConfigVersion}`);
  const workspace = requireRecord(value.workspace, "workspace");
  const agents = requireRecord(value.agents, "agents");
  const executables = requireRecord(agents.executables, "agents.executables");
  const serve = requireRecord(value.serve, "serve");
  const tailscale = requireRecord(serve.tailscale, "serve.tailscale");
  const updates = requireRecord(value.updates, "updates");
  assertKeys(workspace, ["roots"], "workspace");
  assertKeys(agents, ["enabled", "default", "executables"], "agents");
  assertKeys(executables, muximoAgentBackends, "agents.executables");
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
  const args = requireStringArray("serve.tailscale.args", tailscale.args, true);
  const hostname = tailscale.hostname === null ? null : requireString("serve.tailscale.hostname", tailscale.hostname);
  const externalPort = requireNumber("serve.tailscale.externalPort", tailscale.externalPort);
  if (externalPort < 1 || externalPort > 65_535) throw new Error("serve.tailscale.externalPort is out of range");
  return {
    version: muximoConfigVersion,
    workspace: { roots: requireStringArray("workspace.roots", workspace.roots, true) },
    agents: {
      enabled,
      default: defaultBackend,
      executables: validatedExecutables,
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
