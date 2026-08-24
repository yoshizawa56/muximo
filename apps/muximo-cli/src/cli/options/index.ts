import type { Command, OptionValues } from "commander";

export type CliOptionExposure = "cli" | "environment" | "both";

export type CliCompletionSpec =
  | { kind: "none" }
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "url" }
  | { kind: "integer" }
  | { kind: "choices"; values: readonly string[] };

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
  description: string;
  exposure: CliOptionExposure;
  environment?: CliEnvironmentBinding;
  defaultValue?: T;
  repeatable?: boolean;
  completion?: CliCompletionSpec;
};

export type CliOptionSource = "cli" | "environment" | "default";

export type CliOptionResolution = {
  values: Record<string, unknown>;
  sources: Readonly<Record<string, CliOptionSource>>;
};

const optionSpecsByCommand = new WeakMap<Command, CliOptionSpec[]>();
const environmentHelpByCommand = new WeakSet<Command>();

export function defineOptions<const T extends readonly CliOptionSpec[]>(...specs: T): T {
  return specs;
}

export function registerOptions(command: Command, specs: readonly CliOptionSpec[]): Command {
  const registered = optionSpecsByCommand.get(command) ?? [];
  registered.push(...specs);
  optionSpecsByCommand.set(command, registered);

  for (const spec of specs) {
    for (const flags of spec.flags ?? []) {
      const description = formatOptionDescription(spec);
      if (spec.repeatable) {
        command.option(flags, description, collectOption);
      } else {
        command.option(flags, description);
      }
    }
  }
  appendEnvironmentOnlyHelp(command, specs);
  return command;
}

export function getRegisteredOptions(command: Command): readonly CliOptionSpec[] {
  return optionSpecsByCommand.get(command) ?? [];
}

export function resolveOptionValues(
  raw: OptionValues | Record<string, unknown>,
  specs: readonly CliOptionSpec[],
  input: { args: readonly string[]; environment: NodeJS.ProcessEnv },
): CliOptionResolution {
  const values: Record<string, unknown> = {};
  const sources: Record<string, CliOptionSource> = {};
  const uniqueSpecs = uniqueOptionSpecs(specs);

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

    if (spec.defaultValue !== undefined) {
      values[spec.key] = spec.defaultValue;
      sources[spec.key] = "default";
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(raw, spec.key) && raw[spec.key] !== undefined) {
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
  input: { args: readonly string[]; environment: NodeJS.ProcessEnv },
): Record<string, unknown> {
  return resolveOptionValues(raw, specs, input).values;
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
      environment: existing.environment ?? spec.environment,
      defaultValue: existing.defaultValue ?? spec.defaultValue,
      completion: existing.completion ?? spec.completion,
      repeatable: existing.repeatable || spec.repeatable,
    });
  }
  return [...byKey.values()];
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

function formatOptionDescription(spec: CliOptionSpec): string {
  if (!spec.environment) return spec.description;
  return `${spec.description}\nEnvironment: ${spec.environment.name} — ${spec.environment.description}`;
}

function appendEnvironmentOnlyHelp(command: Command, specs: readonly CliOptionSpec[]): void {
  if (environmentHelpByCommand.has(command)) return;
  const environmentOnly = specs.filter(
    (spec) => !spec.flags?.length && spec.environment && spec.exposure !== "cli",
  );
  if (environmentOnly.length === 0) return;

  command.addHelpText(
    "after",
    `\nEnvironment variables:\n${environmentOnly
      .map((spec) => `  ${spec.environment?.name}\n    ${spec.description}: ${spec.environment?.description}`)
      .join("\n")}\n`,
  );
  environmentHelpByCommand.add(command);
}
