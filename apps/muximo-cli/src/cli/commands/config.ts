import { type MuximoConfigSetting, muximoConfigKeys, muximoConfigSettings } from "@muximo/profile";
import type { Command } from "commander";
import { z } from "zod";
import { type CliArgumentSpec, type CliCompletionSpec, registerArguments } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const configSchema = z.object({
  command: z.enum(["init", "path", "show", "get", "set"]),
  key: z.string().trim().min(1).optional(),
  values: z.array(z.string()).default([]),
});

export function registerConfigCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const config = parent.command("config").description("Manage the instance configuration");
  config.action(() => context.report(2));
  registerConfigAction(
    config.command("init").description("Create or edit the configuration interactively"),
    {
      command: "init",
    },
    handlers,
    context,
  );
  registerConfigAction(
    config.command("path").description("Print the configuration file path"),
    {
      command: "path",
    },
    handlers,
    context,
  );
  registerConfigAction(
    config.command("show").description("Print the complete configuration as JSON"),
    {
      command: "show",
    },
    handlers,
    context,
  );
  registerConfigAction(
    registerArguments(config.command("get <key>").description("Print one configuration value"), [
      createConfigKeyArgument(),
    ]).addHelpText("after", formatConfigSettingsHelp("get")),
    {
      command: "get",
    },
    handlers,
    context,
  );
  registerConfigAction(
    registerArguments(config.command("set <key> [values...]").description("Set one configuration value"), [
      createConfigKeyArgument(),
      {
        key: "value",
        description: "Value for the selected configuration key",
        repeatable: true,
        completion: {
          kind: "dependent",
          dependsOn: "key",
          values: configValueCompletions(),
          fallback: { kind: "none" },
        },
      },
    ]).addHelpText("after", formatConfigSettingsHelp("set")),
    {
      command: "set",
    },
    handlers,
    context,
  );
  return config;
}

function createConfigKeyArgument(): CliArgumentSpec {
  return {
    key: "key",
    description: "Configuration key",
    completion: { kind: "choices", values: muximoConfigKeys },
  };
}

function configValueCompletions(): Readonly<Record<string, CliCompletionSpec>> {
  return Object.fromEntries(muximoConfigSettings.map((setting) => [setting.key, configSettingCompletion(setting)]));
}

function configSettingCompletion(setting: MuximoConfigSetting): CliCompletionSpec {
  switch (setting.valueKind) {
    case "directory-list":
      return { kind: "directory" };
    case "agent-list":
    case "choice":
      return { kind: "choices", values: setting.choices ?? [] };
    case "agent-or-none":
      return { kind: "choices", values: setting.choices ?? [] };
    case "executable":
      return { kind: "file" };
    case "boolean":
      return { kind: "choices", values: ["true", "false"] };
    case "string-or-none":
      return { kind: "choices", values: ["none"] };
    case "integer":
    case "string-list":
    case "string":
      return { kind: "none" };
  }
}

export function formatConfigSettingsHelp(command: "get" | "set"): string {
  const title = command === "set" ? "Configuration keys and value formats:" : "Configuration keys:";
  const settings = muximoConfigSettings
    .map((setting) => {
      const choices = "choices" in setting ? `\n    Choices: ${setting.choices.join(", ")}` : "";
      const example =
        setting.example === undefined
          ? ""
          : `\n    Example: muximo config ${command} ${setting.key}${command === "set" ? ` ${setting.example}` : ""}`;
      return `  ${setting.key}\n    ${setting.description}\n    Value: ${setting.valueDescription}${choices}${example}`;
    })
    .join("\n");
  return `\n${title}\n${settings}\n`;
}

function registerConfigAction(
  command: Command,
  fixed: { command: "init" | "path" | "show" | "get" | "set" },
  handlers: CliHandlers,
  context: CliCommandContext,
): void {
  const dispatch = async (key: string | undefined, values: string[] | undefined) => {
    context.report(
      await invokeCliHandler({
        schema: configSchema,
        rawInput: { ...fixed, ...(key === undefined ? {} : { key }), values: values ?? [] },
        commandPath: ["config", fixed.command],
        context,
        handler: handlers.config,
      }),
    );
  };
  if (fixed.command === "init" || fixed.command === "path" || fixed.command === "show") {
    command.action(() => dispatch(undefined, undefined));
  } else if (fixed.command === "get") {
    command.action((key: string) => dispatch(key, undefined));
  } else {
    command.action((key: string, values: string[]) => dispatch(key, values));
  }
}
