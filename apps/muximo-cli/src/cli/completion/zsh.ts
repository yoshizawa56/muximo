import type { Command } from "commander";
import {
  type CliArgumentSpec,
  type CliCompletionSpec,
  type CliOptionSpec,
  getRegisteredArguments,
  getRegisteredOptions,
} from "../options/index.js";

type CompletionNode = {
  command: Command;
  path: readonly string[];
  children: readonly CompletionNode[];
  arguments: readonly CliArgumentSpec[];
  options: readonly CliOptionSpec[];
};

/** Generates a self-contained zsh completion function from the Commander tree. */
export function generateZshCompletion(program: Command): string {
  const rootName = program.name();
  const rootNode = createCompletionNode(program, [], []);
  const functionName = `_${sanitizeName(rootName)}`;
  const lines = [`#compdef ${rootName}`, ""];

  appendNodeFunction(lines, rootNode, functionName);
  lines.push(`${functionName}() {`, `  ${functionName}_root`, `}`, `compdef ${functionName} ${rootName}`, "");
  return `${lines.join("\n")}\n`;
}

function createCompletionNode(
  command: Command,
  path: readonly string[],
  inheritedOptions: readonly CliOptionSpec[],
): CompletionNode {
  const options = mergeOptions(inheritedOptions, getRegisteredOptions(command));
  const children = command.commands.map((child) => createCompletionNode(child, [...path, child.name()], options));
  return { command, path, children, arguments: getRegisteredArguments(command), options };
}

function appendNodeFunction(lines: string[], node: CompletionNode, rootFunctionName: string): void {
  const functionName = `${rootFunctionName}_${node.path.length === 0 ? "root" : node.path.map(sanitizeName).join("_")}`;
  const rendered = renderArguments(
    node,
    node.options,
    node.children.flatMap((child) => commandNames(child.command)),
    rootFunctionName,
  );
  lines.push(`${functionName}() {`);

  if (node.children.length === 0) {
    lines.push(`  _arguments -s ${rendered.value}`, "}", "");
  } else {
    const wordIndex = node.path.length + 2;
    lines.push(`  case "\${words[${wordIndex}]:-}" in`);
    for (const child of node.children) {
      const childFunctionName = `${rootFunctionName}_${child.path.map(sanitizeName).join("_")}`;
      for (const name of commandNames(child.command)) {
        lines.push(`    ${shellQuote(name)}) ${childFunctionName} ;;`);
      }
    }
    lines.push(`    *) _arguments -s ${rendered.value} ;;`, "  esac", "}", "");
  }

  lines.push(...rendered.helpers);
  for (const child of node.children) appendNodeFunction(lines, child, rootFunctionName);
}

function commandNames(command: Command): string[] {
  return [...new Set([command.name(), ...command.aliases()])];
}

function renderArguments(
  node: CompletionNode,
  options: readonly CliOptionSpec[],
  children: readonly string[],
  rootFunctionName: string,
): { value: string; helpers: readonly string[] } {
  const context: CompletionRenderContext = { node, rootFunctionName, helpers: [] };
  const argumentsList = [renderHelpOption(), ...options.flatMap((spec) => renderOption(spec, context))];
  if (children.length > 0) argumentsList.push(renderCommandArgument(children));
  if (node.arguments.length > 0) {
    argumentsList.push(...node.arguments.map((spec, index) => renderArgument(spec, index + 1, context)));
  } else {
    argumentsList.push("'*:argument:_default'");
  }
  return { value: argumentsList.join(" "), helpers: context.helpers };
}

function renderOption(spec: CliOptionSpec, context: CompletionRenderContext): string[] {
  return (spec.flags ?? []).flatMap((flags) => {
    const valueMatch = /(?:<([^>]+)>|\[([^\]]+)\])/u.exec(flags);
    const valueName = (valueMatch?.[1] ?? valueMatch?.[2])?.replace(/\.\.\.$/u, "");
    const repeatPrefix = spec.repeatable ? "*" : "";
    return flags
      .split(",")
      .map((part) => part.trim().split(/\s+/u)[0])
      .filter((name) => name.length > 0)
      .map((name) => {
        const description = escapeZshText(spec.flagDescriptions?.[name] ?? spec.description);
        const optionValueName = name.startsWith("--no-") ? undefined : valueName;
        const completion = optionValueName
          ? `:${optionValueName}:${renderValueCompletion(spec.completion, context)}`
          : "";
        return shellQuote(`${repeatPrefix}${name}[${description}]${completion}`);
      });
  });
}

function renderArgument(spec: CliArgumentSpec, index: number, context: CompletionRenderContext): string {
  const position = spec.repeatable ? "*" : String(index);
  const description = escapeZshText(`${spec.key} — ${spec.description}`);
  const completion = renderValueCompletion(spec.completion, context);
  return shellQuote(`${position}:${description}:${completion}`);
}

function renderHelpOption(): string {
  return "'(-h --help)'{-h,--help}'[Display help]'";
}

function renderCommandArgument(children: readonly string[]): string {
  return `'1:command:(${children.map(escapeZshText).join(" ")})'`;
}

type CompletionRenderContext = {
  node: CompletionNode;
  rootFunctionName: string;
  helpers: string[];
};

function renderValueCompletion(spec: CliCompletionSpec | undefined, context: CompletionRenderContext): string {
  switch (spec?.kind) {
    case "choices":
      return `(${spec.values.map(escapeZshText).join(" ")})`;
    case "file":
      return "_files";
    case "directory":
      return "_directories";
    case "url":
      return "_urls";
    case "integer":
    case "none":
    case undefined:
      return "";
    case "dependent":
      return renderDependentCompletion(spec, context);
  }
}

function renderDependentCompletion(
  spec: Extract<CliCompletionSpec, { kind: "dependent" }>,
  context: CompletionRenderContext,
): string {
  const dependencyIndex = context.node.arguments.findIndex((argument) => argument.key === spec.dependsOn);
  if (dependencyIndex < 0) return renderValueCompletion(spec.fallback, context);

  const helperName = `${context.rootFunctionName}_${context.node.path.map(sanitizeName).join("_")}_${sanitizeName(spec.dependsOn)}_values`;
  const dependencyWordIndex = context.node.path.length + 2 + dependencyIndex;
  const lines = [`${helperName}() {`, `  case "\${words[${dependencyWordIndex}]:-}" in`];
  for (const [value, completion] of Object.entries(spec.values)) {
    lines.push(`    ${shellQuote(value)}) ${renderCompletionCommand(completion)} ;;`);
  }
  lines.push(`    *) ${renderCompletionCommand(spec.fallback)} ;;`, "  esac", "}", "");
  context.helpers.push(lines.join("\n"));
  return helperName;
}

function renderCompletionCommand(spec: CliCompletionSpec | undefined): string {
  switch (spec?.kind) {
    case "choices":
      return `compadd -- ${spec.values.map(shellQuote).join(" ")}`;
    case "file":
      return "_files";
    case "directory":
      return "_directories";
    case "url":
      return "_urls";
    case "dependent":
      return renderCompletionCommand(spec.fallback);
    case "integer":
    case "none":
    case undefined:
      return "_default";
  }
}

function mergeOptions(inherited: readonly CliOptionSpec[], local: readonly CliOptionSpec[]): CliOptionSpec[] {
  const options = new Map<string, CliOptionSpec>();
  for (const spec of [...inherited, ...local]) {
    const existing = options.get(spec.key);
    if (!existing) {
      options.set(spec.key, spec);
      continue;
    }
    options.set(spec.key, {
      ...existing,
      flags: [...new Set([...(existing.flags ?? []), ...(spec.flags ?? [])])],
      flagDescriptions: { ...existing.flagDescriptions, ...spec.flagDescriptions },
    });
  }
  return [...options.values()];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeZshText(value: string): string {
  return value.replace(/[()[\]{}*?\\|]/gu, "\\$&").replaceAll(" ", "\\ ");
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/gu, "_");
}
