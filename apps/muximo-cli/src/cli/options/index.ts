import type { Command, OptionValues } from "commander";
import { type CliBuildMode, isAvailableIn } from "../build-mode.js";

export type CliOptionExposure = "cli" | "environment" | "both";

export type CliCompletionSpec =
  | { kind: "none" }
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "url" }
  | { kind: "integer" }
  | { kind: "choices"; values: readonly string[] }
  | {
      kind: "dependent";
      dependsOn: string;
      values: Readonly<Record<string, CliCompletionSpec>>;
      fallback?: CliCompletionSpec;
    };

export type CliEnvironmentBinding = {
  name: string;
  description: string;
  decode?: (value: string) => unknown;
};

export type CliOptionSpec<T = unknown> = {
  /** The Commander option key and the canonical key used by the command input. */
  key: string;
  /** Commander flags. Multiple entries describe aliases or negated forms. */
  flags?: readonly string[];
  /** Optional descriptions for individual flags, such as a negated form. */
  flagDescriptions?: Readonly<Record<string, string>>;
  description: string;
  exposure: CliOptionExposure;
  availableIn?: readonly CliBuildMode[];
  environment?: CliEnvironmentBinding;
  defaultValue?: T | ((environment: NodeJS.ProcessEnv) => T);
  repeatable?: boolean;
  completion?: CliCompletionSpec;
};

export type CliArgumentSpec = {
  /** The positional argument name used by Commander and completion output. */
  key: string;
  description: string;
  repeatable?: boolean;
  completion?: CliCompletionSpec;
};

export type CliOptionSource = "cli" | "environment" | "default";

export type CliOptionResolution = {
  values: Record<string, unknown>;
  sources: Readonly<Record<string, CliOptionSource>>;
};

const optionSpecsByCommand = new WeakMap<Command, CliOptionSpec[]>();
const argumentSpecsByCommand = new WeakMap<Command, CliArgumentSpec[]>();
const environmentHelpByCommand = new WeakSet<Command>();

export function defineOptions<const T extends readonly CliOptionSpec[]>(...specs: T): T {
  return specs;
}

export function registerOptions(
  command: Command,
  specs: readonly CliOptionSpec[],
  buildMode: CliBuildMode = "development",
): Command {
  const availableSpecs = getAvailableOptionSpecs(specs, buildMode);
  const registered = optionSpecsByCommand.get(command) ?? [];
  registered.push(...availableSpecs);
  optionSpecsByCommand.set(command, registered);

  for (const spec of availableSpecs) {
    for (const flags of spec.flags ?? []) {
      const description = formatOptionDescription(spec, flags);
      if (spec.repeatable) {
        command.option(flags, description, collectOption);
      } else {
        command.option(flags, description);
      }
    }
  }
  appendEnvironmentOnlyHelp(command, availableSpecs);
  return command;
}

export function getAvailableOptionSpecs(specs: readonly CliOptionSpec[], buildMode: CliBuildMode): CliOptionSpec[] {
  return specs.filter((spec) => isAvailableIn(spec.availableIn, buildMode));
}

export function getRegisteredOptions(command: Command): readonly CliOptionSpec[] {
  return optionSpecsByCommand.get(command) ?? [];
}

export function registerArguments(command: Command, specs: readonly CliArgumentSpec[]): Command {
  const registered = argumentSpecsByCommand.get(command) ?? [];
  registered.push(...specs);
  argumentSpecsByCommand.set(command, registered);
  return command;
}

export function getRegisteredArguments(command: Command): readonly CliArgumentSpec[] {
  return argumentSpecsByCommand.get(command) ?? [];
}

/** Reads values for a command's options before Commander is constructed. */
export function readOptionValues(
  args: readonly string[],
  specs: readonly CliOptionSpec[],
  buildMode: CliBuildMode = "development",
): Record<string, unknown> {
  const definitions = optionDefinitions(getAvailableOptionSpecs(specs, buildMode));
  const values: Record<string, unknown> = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") break;
    const definition = findOptionDefinition(argument, definitions);
    if (!definition) continue;

    const inlineValue = readInlineValue(argument, definition.name);
    let value: unknown;
    if (definition.valueKind === "required") {
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else {
        const next = args[++index];
        if (next === undefined) throw new Error(`option ${definition.name} requires a value`);
        value = next;
      }
    } else if (definition.valueKind === "optional") {
      if (inlineValue !== undefined) {
        value = inlineValue;
      } else if (args[index + 1] !== undefined && !args[index + 1].startsWith("-")) {
        value = args[++index];
      } else {
        value = true;
      }
    } else {
      value = !definition.name.startsWith("--no-");
    }

    if (definition.spec.repeatable) {
      const previous = values[definition.spec.key];
      values[definition.spec.key] = [...(Array.isArray(previous) ? previous : []), value];
    } else {
      values[definition.spec.key] = value;
    }
  }

  return values;
}

export type RootOptionScan = {
  options: readonly string[];
  commandIndex: number;
};

/** Splits global options from the first command for the entrypoint bootstrap. */
export function scanRootOptions(
  args: readonly string[],
  specs: readonly CliOptionSpec[],
  buildMode: CliBuildMode = "development",
): RootOptionScan {
  const definitions = optionDefinitions(getAvailableOptionSpecs(specs, buildMode));
  const options: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return { options, commandIndex: -1 };

    const definition = findOptionDefinition(argument, definitions);
    if (!definition) {
      if (argument.startsWith("-")) {
        options.push(argument);
        continue;
      }
      return { options, commandIndex: index };
    }

    options.push(argument);
    const inlineValue = readInlineValue(argument, definition.name);
    if (definition.valueKind === "required" && inlineValue === undefined) {
      const next = args[index + 1];
      if (next !== undefined) {
        options.push(next);
        index += 1;
      }
    } else if (
      definition.valueKind === "optional" &&
      inlineValue === undefined &&
      args[index + 1] !== undefined &&
      !args[index + 1].startsWith("-")
    ) {
      options.push(args[index + 1]);
      index += 1;
    }
  }

  return { options, commandIndex: -1 };
}

export function resolveOptionValues(
  raw: OptionValues | Record<string, unknown>,
  specs: readonly CliOptionSpec[],
  input: { args: readonly string[]; environment: NodeJS.ProcessEnv; buildMode?: CliBuildMode },
): CliOptionResolution {
  const values: Record<string, unknown> = {};
  const sources: Record<string, CliOptionSource> = {};
  const uniqueSpecs = uniqueOptionSpecs(getAvailableOptionSpecs(specs, input.buildMode ?? "development"));

  for (const spec of uniqueSpecs) {
    const cliSpecified = isCliOptionSpecified(input.args, spec);
    if (cliSpecified) {
      const rawValue = raw[spec.key];
      values[spec.key] = rawValue === undefined ? inferFlagValue(input.args, spec) : rawValue;
      sources[spec.key] = "cli";
      continue;
    }

    if ((spec.exposure === "environment" || spec.exposure === "both") && spec.environment) {
      const rawEnvironmentValue = input.environment[spec.environment.name];
      if (rawEnvironmentValue !== undefined) {
        values[spec.key] = spec.environment.decode?.(rawEnvironmentValue) ?? rawEnvironmentValue;
        sources[spec.key] = "environment";
        continue;
      }
    }

    const defaultValue = resolveDefaultValue(spec.defaultValue, input.environment);
    if (defaultValue !== undefined) {
      values[spec.key] = defaultValue;
      sources[spec.key] = "default";
      continue;
    }

    if (Object.hasOwn(raw, spec.key) && raw[spec.key] !== undefined) {
      values[spec.key] = raw[spec.key];
      sources[spec.key] = "default";
    }
  }

  return { values, sources };
}

export function isCliOptionSpecified(args: readonly string[], spec: CliOptionSpec): boolean {
  if (!spec.flags?.length) return false;
  const end = args.indexOf("--");
  const commandArguments = end < 0 ? args : args.slice(0, end);
  const names = spec.flags.flatMap(optionFlagNames);
  return commandArguments.some((argument) =>
    names.some((name) => argument === name || (name.startsWith("--") && argument.startsWith(`${name}=`))),
  );
}

export function collectOption(value: string, previous?: readonly string[]): string[] {
  return [...(previous ?? []), value];
}

export function resolveCliOptions(
  raw: OptionValues | Record<string, unknown>,
  specs: readonly CliOptionSpec[],
  input: { args: readonly string[]; environment: NodeJS.ProcessEnv; buildMode?: CliBuildMode },
): Record<string, unknown> {
  return resolveOptionValues(raw, specs, input).values;
}

export function assertAvailableOptions(
  args: readonly string[],
  specs: readonly CliOptionSpec[],
  buildMode: CliBuildMode,
): void {
  const definitions = optionDefinitions(specs);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return;

    const definition = findOptionDefinition(argument, definitions);
    if (!definition) {
      if (argument.startsWith("-")) continue;
      return;
    }
    if (!isAvailableIn(definition.spec.availableIn, buildMode)) {
      throw new Error(`${definition.name} is not available in ${buildMode} builds`);
    }

    const inlineValue = readInlineValue(argument, definition.name);
    if (definition.valueKind === "required" && inlineValue === undefined) {
      index += 1;
    } else if (
      definition.valueKind === "optional" &&
      inlineValue === undefined &&
      args[index + 1] !== undefined &&
      !args[index + 1].startsWith("-")
    ) {
      index += 1;
    }
  }
}

function uniqueOptionSpecs(specs: readonly CliOptionSpec[]): CliOptionSpec[] {
  const byKey = new Map<string, CliOptionSpec>();
  for (const spec of specs) {
    const existing = byKey.get(spec.key);
    if (!existing) {
      byKey.set(spec.key, spec);
      continue;
    }
    byKey.set(spec.key, {
      ...existing,
      flags: [...new Set([...(existing.flags ?? []), ...(spec.flags ?? [])])],
      flagDescriptions: { ...existing.flagDescriptions, ...spec.flagDescriptions },
      environment: existing.environment ?? spec.environment,
      defaultValue: existing.defaultValue ?? spec.defaultValue,
      completion: existing.completion ?? spec.completion,
      repeatable: existing.repeatable || spec.repeatable,
    });
  }
  return [...byKey.values()];
}

function resolveDefaultValue<T>(
  value: T | ((environment: NodeJS.ProcessEnv) => T) | undefined,
  environment: NodeJS.ProcessEnv,
): T | undefined {
  return typeof value === "function" ? (value as (environment: NodeJS.ProcessEnv) => T)(environment) : value;
}

type OptionFlagDefinition = {
  name: string;
  valueKind: "none" | "required" | "optional";
};

function parseOptionFlag(value: string): OptionFlagDefinition | undefined {
  const name = value.split(/\s+/u)[0];
  if (!name) return undefined;
  return {
    name,
    valueKind: value.includes("<") ? "required" : value.includes("[") ? "optional" : "none",
  };
}

function optionDefinitions(specs: readonly CliOptionSpec[]): Array<OptionFlagDefinition & { spec: CliOptionSpec }> {
  return specs.flatMap((spec) =>
    (spec.flags ?? []).flatMap((flags) =>
      flags
        .split(",")
        .map((part) => parseOptionFlag(part.trim()))
        .filter((definition): definition is OptionFlagDefinition => definition !== undefined)
        .map((definition) => ({ ...definition, spec })),
    ),
  );
}

function findOptionDefinition(
  argument: string,
  definitions: readonly (OptionFlagDefinition & { spec: CliOptionSpec })[],
): (OptionFlagDefinition & { spec: CliOptionSpec }) | undefined {
  return definitions.find(
    (candidate) =>
      argument === candidate.name || (candidate.name.startsWith("--") && argument.startsWith(`${candidate.name}=`)),
  );
}

function readInlineValue(argument: string, name: string): string | undefined {
  return name.startsWith("--") && argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : undefined;
}

function inferFlagValue(args: readonly string[], spec: CliOptionSpec): boolean {
  const matched = spec.flags
    ?.flatMap(optionFlagNames)
    .find((name) => args.some((argument) => argument === name || argument.startsWith(`${name}=`)));
  return matched?.startsWith("--no-") !== true;
}

function optionFlagNames(flags: string): string[] {
  return flags
    .split(",")
    .map((part) => part.trim().split(/\s+/u)[0])
    .filter((part): part is string => Boolean(part));
}

function formatOptionDescription(spec: CliOptionSpec, flags: string): string {
  const description =
    optionFlagNames(flags)
      .map((name) => spec.flagDescriptions?.[name])
      .find((value): value is string => value !== undefined) ?? spec.description;
  if (!spec.environment) return description;
  const environmentDescription =
    spec.environment.description === description ? "" : ` — ${spec.environment.description}`;
  return `${description}\nEnvironment: ${spec.environment.name}${environmentDescription}`;
}

function appendEnvironmentOnlyHelp(command: Command, specs: readonly CliOptionSpec[]): void {
  if (environmentHelpByCommand.has(command)) return;
  const environmentOnly = specs.filter((spec) => !spec.flags?.length && spec.environment && spec.exposure !== "cli");
  if (environmentOnly.length === 0) return;

  command.addHelpText(
    "after",
    `\nEnvironment variables:\n${environmentOnly
      .map((spec) => `  ${spec.environment?.name}\n    ${spec.description}: ${spec.environment?.description}`)
      .join("\n")}\n`,
  );
  environmentHelpByCommand.add(command);
}
