import {
  defaultMuximoConfig,
  diffMuximoConfig,
  formatMuximoConfigValue,
  getMuximoConfigSetting,
  getMuximoConfigValue,
  type MuximoAgentBackend,
  type MuximoConfig,
  type MuximoConfigKey,
  type MuximoConfigSetting,
  type MuximoConfigValue,
  muximoAgentBackends,
  muximoConfigSettingsForGroup,
  parseMuximoConfigValue,
  setMuximoConfigValue,
} from "@muximo/instance-contract";
import type { ConfigPrompt, ConfigPromptChoice } from "./adapters/inquirer-config-prompt.js";
import {
  completeExecutablePath,
  discoverAgentExecutableCandidates,
  discoverTailscaleExecutableCandidates,
  type ExecutableCandidate,
  type ExecutableDiscoveryContext,
  executableValidationMessage,
  isExecutableReference,
  recommendedTailscaleExecutable,
} from "./adapters/path-completion.js";

export type ConfigInitDependencies = Readonly<{
  prompt: ConfigPrompt;
  output: NodeJS.WritableStream;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}>;

type TailscaleMode = "disabled" | "recommended" | "custom";
type AdditionalMode = "recommended" | "custom" | "all";
type AdditionalArea =
  | "workspace"
  | "daemon"
  | "logging"
  | "database"
  | "agent-connection"
  | "agent-executables"
  | "updates";
type ReviewAction = "save" | "agents" | "tailscale" | "additional" | "cancel";

const additionalAreaLabels: Readonly<Record<AdditionalArea, string>> = {
  workspace: "Workspace discovery",
  daemon: "Daemon network",
  logging: "Logging",
  database: "Database schema",
  "agent-connection": "Agent connection behavior",
  "agent-executables": "Agent executable paths",
  updates: "Update behavior",
};

export async function runMuximoConfigInit(
  initialConfig: MuximoConfig,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig | null> {
  let config = structuredClone(initialConfig);
  config = await configureAgents(config, dependencies);
  config = await configureTailscale(config, dependencies);
  config = await configureAdditionalSettings(config, dependencies);
  return reviewConfiguration(initialConfig, config, dependencies);
}

async function configureAgents(config: MuximoConfig, dependencies: ConfigInitDependencies): Promise<MuximoConfig> {
  const discoveryContext = createDiscoveryContext(dependencies);
  const choices = muximoAgentBackends.map((backend) => ({
    value: backend,
    label: backend,
    description: describeAgentCandidates(discoverAgentExecutableCandidates(backend, discoveryContext)),
    checked: config.agents.enabled.includes(backend),
  }));
  const selected = await dependencies.prompt.checkbox({
    message: "Select agents to enable (optional; select none to disable all agent backends)",
    choices,
  });
  let next = applyConfigValue(config, "agents.enabled", selected);
  if (selected.length === 0) {
    return applyConfigValue(next, "agents.default", null);
  }
  if (selected.length === 1) {
    next = applyConfigValue(next, "agents.default", selected[0] ?? null);
  } else {
    const defaultChoices = [
      ...selected.map((backend) => ({ value: backend, label: backend })),
      { value: "none", label: "No default agent" },
    ];
    const currentDefault =
      next.agents.default === null ? "none" : selected.includes(next.agents.default) ? next.agents.default : undefined;
    const selectedDefault = await dependencies.prompt.select({
      message: "Select the default agent",
      choices: defaultChoices,
      ...(currentDefault === undefined ? {} : { defaultValue: currentDefault }),
    });
    next = applyConfigValue(next, "agents.default", selectedDefault === "none" ? null : selectedDefault);
  }
  for (const backend of selected) {
    next = await configureAgentExecutable(next, backend as MuximoAgentBackend, dependencies);
  }
  return next;
}

async function configureAgentExecutable(
  config: MuximoConfig,
  backend: MuximoAgentBackend,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const discoveryContext = createDiscoveryContext(dependencies);
  const currentValue = getMuximoConfigValue(config, `agents.executables.${backend}`);
  if (typeof currentValue === "string" && isExecutableReference(currentValue, discoveryContext)) return config;
  const candidates = discoverAgentExecutableCandidates(
    backend,
    discoveryContext,
    typeof currentValue === "string" ? currentValue : undefined,
  );
  if (candidates.length === 1) {
    return applyConfigValue(config, `agents.executables.${backend}`, candidates[0]?.value ?? null);
  }
  if (candidates.length > 1) {
    const selected = await dependencies.prompt.select({
      message: `Select the executable for ${backend}`,
      choices: candidates.map(toExecutableChoice),
    });
    return applyConfigValue(config, `agents.executables.${backend}`, selected);
  }
  return promptExecutable(config, `agents.executables.${backend}`, backend, dependencies);
}

async function configureTailscale(config: MuximoConfig, dependencies: ConfigInitDependencies): Promise<MuximoConfig> {
  const currentMode: TailscaleMode = config.serve.tailscale.enabled ? "custom" : "disabled";
  const mode = (await dependencies.prompt.select({
    message: "How should Tailscale Serve be used?",
    choices: [
      { value: "disabled", label: "Disabled" },
      { value: "recommended", label: "Enabled with recommended settings" },
      { value: "custom", label: "Customize Tailscale settings" },
    ],
    defaultValue: currentMode,
  })) as TailscaleMode;
  if (mode === "disabled") return applyConfigValue(config, "serve.tailscale.enabled", false);
  let next = applyConfigValue(config, "serve.tailscale.enabled", true);
  if (mode === "recommended") return ensureTailscaleExecutable(next, dependencies, false, true);

  const fields = await dependencies.prompt.checkbox({
    message: "Which Tailscale settings should be customized?",
    choices: [
      { value: "serve.tailscale.executable", label: "Executable" },
      { value: "serve.tailscale.args", label: "Command arguments" },
      { value: "serve.tailscale.hostname", label: "Hostname" },
      { value: "serve.tailscale.externalPort", label: "External port" },
      { value: "serve.tailscale.path", label: "URL path" },
    ],
    validate: (values) => (values.length > 0 ? true : "Select at least one setting to customize."),
  });
  next = await ensureTailscaleExecutable(next, dependencies, fields.includes("serve.tailscale.executable"));
  for (const key of fields) {
    if (key === "serve.tailscale.executable") {
      next = await promptExecutable(next, key, "tailscale", dependencies);
    } else {
      next = await promptSetting(next, key as MuximoConfigKey, dependencies);
    }
  }
  return next;
}

async function ensureTailscaleExecutable(
  config: MuximoConfig,
  dependencies: ConfigInitDependencies,
  forcePrompt: boolean,
  preferRecommended = false,
): Promise<MuximoConfig> {
  const discoveryContext = createDiscoveryContext(dependencies);
  const currentValue = config.serve.tailscale.executable;
  if (!forcePrompt && !preferRecommended && isExecutableReference(currentValue, discoveryContext)) return config;
  const candidates = discoverTailscaleExecutableCandidates(
    discoveryContext,
    forcePrompt || preferRecommended ? undefined : currentValue,
  );
  if (!forcePrompt && candidates.length > 0) {
    return applyConfigValue(config, "serve.tailscale.executable", candidates[0]?.value ?? currentValue);
  }
  if (!forcePrompt && candidates.length === 0) {
    if (isExecutableReference(currentValue, discoveryContext)) return config;
    return promptExecutable(config, "serve.tailscale.executable", "tailscale", dependencies);
  }
  return config;
}

async function configureAdditionalSettings(
  config: MuximoConfig,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const mode = (await dependencies.prompt.select({
    message: "How should the remaining settings be configured?",
    choices: [
      { value: "recommended", label: "Use recommended defaults" },
      { value: "custom", label: "Customize selected areas" },
      { value: "all", label: "Review every setting" },
    ],
    defaultValue: "recommended",
  })) as AdditionalMode;
  if (mode === "recommended") return applyRecommendedDefaults(config);
  if (mode === "all") return promptAllAdditionalSettings(config, dependencies);
  return promptSelectedAdditionalSettings(config, dependencies);
}

function applyRecommendedDefaults(config: MuximoConfig): MuximoConfig {
  const defaults = defaultMuximoConfig();
  return {
    ...defaults,
    agents: structuredClone(config.agents),
    serve: { tailscale: structuredClone(config.serve.tailscale) },
  };
}

async function promptSelectedAdditionalSettings(
  config: MuximoConfig,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const availableAreas = getAvailableAdditionalAreas(config);
  const selectedAreas = await dependencies.prompt.checkbox({
    message: "Which areas should be customized?",
    choices: availableAreas.map((area) => ({ value: area, label: additionalAreaLabels[area] })),
  });
  let next = config;
  for (const area of selectedAreas as AdditionalArea[]) {
    next = await promptAdditionalArea(next, area, dependencies);
  }
  return next;
}

async function promptAllAdditionalSettings(
  config: MuximoConfig,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  let next = config;
  for (const setting of getAllAdditionalSettings(next)) {
    next = await promptSetting(next, setting.key as MuximoConfigKey, dependencies);
  }
  return next;
}

async function promptAdditionalArea(
  config: MuximoConfig,
  area: AdditionalArea,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const settings = getAdditionalSettings(config, area);
  if (settings.length === 0) return config;
  if (settings.length === 1) return promptSetting(config, settings[0]?.key as MuximoConfigKey, dependencies);
  const selected = await dependencies.prompt.checkbox({
    message: `Which ${additionalAreaLabels[area].toLowerCase()} settings should be customized?`,
    choices: settings.map((setting) => ({ value: setting.key, label: setting.description })),
    validate: (values) => (values.length > 0 ? true : "Select at least one setting to customize."),
  });
  let next = config;
  for (const key of selected) next = await promptSetting(next, key as MuximoConfigKey, dependencies);
  return next;
}

async function promptSetting(
  config: MuximoConfig,
  key: MuximoConfigKey,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const setting = getMuximoConfigSetting(key);
  if (setting === undefined) throw new Error(`unsupported muximo config key: ${key}`);
  if (setting.valueKind === "executable") {
    const backend = executableBackendForKey(key);
    return promptExecutable(config, key, backend, dependencies);
  }
  if (setting.valueKind === "choice" || setting.valueKind === "boolean" || setting.valueKind === "agent-or-none") {
    const choices = setting.valueKind === "boolean" ? ["true", "false"] : (setting.choices ?? []);
    const current = getMuximoConfigValue(config, key);
    const currentValue = current === null ? "none" : String(current);
    const selected = await dependencies.prompt.select({
      message: `${setting.description} (${setting.valueDescription})`,
      choices: choices.map((value) => ({ value, label: value })),
      defaultValue: choices.includes(currentValue) ? currentValue : undefined,
    });
    return applyConfigValue(config, key, parseMuximoConfigValue(key, [selected]));
  }
  const current = formatMuximoConfigValue(key, getMuximoConfigValue(config, key));
  return promptValidatedInput(config, key, setting, dependencies, current.length === 0 ? undefined : current);
}

async function promptValidatedInput(
  config: MuximoConfig,
  key: MuximoConfigKey,
  setting: MuximoConfigSetting,
  dependencies: ConfigInitDependencies,
  defaultValue: string | undefined,
): Promise<MuximoConfig> {
  while (true) {
    const rawValue = await dependencies.prompt.input({
      message: `${setting.description} (${setting.valueDescription})`,
      ...(defaultValue === undefined ? {} : { defaultValue }),
      validate: (value) => validateRawValue(config, key, value),
    });
    try {
      return applyConfigValue(config, key, parseMuximoConfigValue(key, [rawValue]));
    } catch (error) {
      reportInvalidValue(dependencies.output, key, error);
    }
  }
}

async function promptExecutable(
  config: MuximoConfig,
  key: MuximoConfigKey,
  label: string,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig> {
  const context = createDiscoveryContext(dependencies);
  const current = getMuximoConfigValue(config, key);
  const initialValue = typeof current === "string" && current.length > 0 ? current : undefined;
  while (true) {
    const value = await dependencies.prompt.search({
      message: `Enter the ${label} executable path or command`,
      ...(initialValue === undefined ? {} : { initialValue }),
      source: async (term) => executablePromptChoices(term, label, context),
      validate: (candidate) => executableValidationMessage(candidate, context) ?? true,
    });
    const error = executableValidationMessage(value, context);
    if (error === undefined) return applyConfigValue(config, key, value.trim());
    reportInvalidValue(dependencies.output, key, error);
  }
}

function executablePromptChoices(
  term: string | undefined,
  label: string,
  context: ExecutableDiscoveryContext,
): readonly ConfigPromptChoice[] {
  const typed = (term ?? "").trim();
  const candidates =
    label === "tailscale"
      ? discoverTailscaleExecutableCandidates(context)
      : discoverAgentExecutableCandidates(label as MuximoAgentBackend, context);
  const choices: ConfigPromptChoice[] = [];
  if (typed.length > 0)
    choices.push({ value: typed, label: `Use "${typed}"`, description: "Validate this executable" });
  for (const candidate of candidates) choices.push(toExecutableChoice(candidate));
  for (const completion of completeExecutablePath(typed, context)) {
    choices.push({ value: completion, label: completion, description: "Path completion" });
  }
  if (choices.length === 0) {
    const recommended = label === "tailscale" ? recommendedTailscaleExecutable(context.platform) : label;
    choices.push({ value: recommended, label: `Use "${recommended}"`, description: "Validate this executable" });
  }
  return uniquePromptChoices(choices);
}

async function reviewConfiguration(
  initialConfig: MuximoConfig,
  config: MuximoConfig,
  dependencies: ConfigInitDependencies,
): Promise<MuximoConfig | null> {
  let next = config;
  while (true) {
    writeConfigurationSummary(dependencies.output, initialConfig, next);
    const action = (await dependencies.prompt.select({
      message: "What would you like to do?",
      choices: [
        { value: "save", label: "Save configuration" },
        { value: "agents", label: "Change agents" },
        { value: "tailscale", label: "Change Tailscale settings" },
        { value: "additional", label: "Change other settings" },
        { value: "cancel", label: "Cancel" },
      ],
      defaultValue: "save",
    })) as ReviewAction;
    if (action === "save") return next;
    if (action === "cancel") return null;
    if (action === "agents") next = await configureAgents(next, dependencies);
    if (action === "tailscale") next = await configureTailscale(next, dependencies);
    if (action === "additional") next = await configureAdditionalSettings(next, dependencies);
  }
}

function getAvailableAdditionalAreas(config: MuximoConfig): readonly AdditionalArea[] {
  const areas: AdditionalArea[] = ["workspace", "daemon", "logging", "database"];
  if (config.agents.enabled.includes("codex") || config.agents.enabled.includes("opencode")) {
    areas.push("agent-connection");
  }
  if (config.agents.enabled.length > 0) areas.push("agent-executables");
  areas.push("updates");
  return areas;
}

function getAdditionalSettings(config: MuximoConfig, area: AdditionalArea): readonly MuximoConfigSetting[] {
  switch (area) {
    case "workspace":
      return muximoConfigSettingsForGroup(config, "workspace");
    case "daemon":
      return muximoConfigSettingsForGroup(config, "daemon");
    case "logging":
      return muximoConfigSettingsForGroup(config, "logging");
    case "database":
      return muximoConfigSettingsForGroup(config, "database");
    case "agent-connection":
      return muximoConfigSettingsForGroup(config, "agents").filter(
        (setting) => setting.key === "agents.codexRemote" || setting.key === "agents.opencode.serverUrl",
      );
    case "agent-executables":
      return muximoConfigSettingsForGroup(config, "agents").filter((setting) => setting.valueKind === "executable");
    case "updates":
      return muximoConfigSettingsForGroup(config, "updates");
  }
}

function getAllAdditionalSettings(config: MuximoConfig): readonly MuximoConfigSetting[] {
  const keys = new Set<MuximoConfigKey>(["agents.enabled", "agents.default", "serve.tailscale.enabled"]);
  return muximoConfigSettingsForGroup(config, "daemon")
    .concat(
      muximoConfigSettingsForGroup(config, "logging"),
      muximoConfigSettingsForGroup(config, "database"),
      muximoConfigSettingsForGroup(config, "workspace"),
      muximoConfigSettingsForGroup(config, "agents"),
      muximoConfigSettingsForGroup(config, "serve"),
      muximoConfigSettingsForGroup(config, "updates"),
    )
    .filter((setting) => !keys.has(setting.key as MuximoConfigKey));
}

function executableBackendForKey(key: MuximoConfigKey): "tailscale" | MuximoAgentBackend {
  if (key === "serve.tailscale.executable") return "tailscale";
  const backend = key.slice("agents.executables.".length);
  if (!muximoAgentBackends.includes(backend as MuximoAgentBackend))
    throw new Error(`unsupported executable key: ${key}`);
  return backend as MuximoAgentBackend;
}

function createDiscoveryContext(dependencies: ConfigInitDependencies): ExecutableDiscoveryContext {
  return {
    cwd: dependencies.cwd,
    environment: dependencies.environment,
    platform: dependencies.platform,
  };
}

function validateRawValue(config: MuximoConfig, key: MuximoConfigKey, rawValue: string): string | true {
  try {
    setMuximoConfigValue(config, key, parseMuximoConfigValue(key, [rawValue]));
    return true;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function applyConfigValue(
  config: MuximoConfig,
  key: MuximoConfigKey | string,
  value: MuximoConfigValue | readonly string[],
): MuximoConfig {
  return setMuximoConfigValue(config, key, value);
}

function reportInvalidValue(output: NodeJS.WritableStream, key: string, error: unknown): void {
  output.write(`Invalid value for ${key}: ${error instanceof Error ? error.message : String(error)}\n`);
}

function toExecutableChoice(candidate: ExecutableCandidate): ConfigPromptChoice {
  const description = candidate.source === "platform-default" ? "recommended platform path" : candidate.source;
  return { value: candidate.value, label: candidate.value, description };
}

function describeAgentCandidates(candidates: readonly ExecutableCandidate[]): string {
  const candidate = candidates[0];
  return candidate === undefined ? "executable not found" : `executable detected: ${candidate.value}`;
}

function uniquePromptChoices(choices: readonly ConfigPromptChoice[]): readonly ConfigPromptChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    if (seen.has(choice.value)) return false;
    seen.add(choice.value);
    return true;
  });
}

function writeConfigurationSummary(
  output: NodeJS.WritableStream,
  initialConfig: MuximoConfig,
  config: MuximoConfig,
): void {
  const enabledAgents = config.agents.enabled.length === 0 ? "disabled" : config.agents.enabled.join(", ");
  const defaultAgent = config.agents.default ?? "none";
  const tailscale = config.serve.tailscale.enabled ? "enabled" : "disabled";
  output.write("\nConfiguration summary\n\n");
  output.write(`Agent backends: ${enabledAgents}\n`);
  output.write(`Default agent: ${defaultAgent}\n`);
  output.write(`Tailscale Serve: ${tailscale}\n`);
  output.write(`Workspace roots: ${formatMuximoConfigValue("workspace.roots", config.workspace.roots) || "default"}\n`);
  output.write(`Logging level: ${config.logging.level}\n`);
  output.write(`Update policy: ${config.updates.policy}\n`);
  const changes = diffMuximoConfig(initialConfig, config);
  output.write(`Pending changes: ${changes.length}\n\n`);
}
