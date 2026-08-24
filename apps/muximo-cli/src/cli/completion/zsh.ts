import type { Command } from "commander";
import { getRegisteredOptions, type CliCompletionSpec, type CliOptionSpec } from "../options/index.js";

type CompletionNode = {
  command: Command;
  path: readonly string[];
  children: readonly CompletionNode[];
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
  return { command, path, children, options };
}

function appendNodeFunction(lines: string[], node: CompletionNode, rootFunctionName: string): void {
  const functionName = `${rootFunctionName}_${node.path.length === 0 ? "root" : node.path.map(sanitizeName).join("_")}`;
  lines.push(`${functionName}() {`);

  if (node.children.length === 0) {
    lines.push(`  _arguments -s ${renderArguments(node.options, [])}`, "}", "");
  } else {
    const wordIndex = node.path.length + 2;
    lines.push(`  case "\${words[${wordIndex}]:-}" in`);
    for (const child of node.children) {
      const childFunctionName = `${rootFunctionName}_${child.path.map(sanitizeName).join("_")}`;
      lines.push(`    ${shellQuote(child.command.name())}) ${childFunctionName} ;;`);
    }
    lines.push(
      `    *) _arguments -s ${renderArguments(node.options, node.children.map((child) => child.command.name()))} ;;`,
      "  esac",
      "}",
      "",
    );
  }

  for (const child of node.children) appendNodeFunction(lines, child, rootFunctionName);
}

function renderArguments(options: readonly CliOptionSpec[], children: readonly string[]): string {
  const argumentsList = [renderHelpOption(), ...options.flatMap(renderOption)];
  if (children.length > 0) argumentsList.push(renderCommandArgument(children));
  argumentsList.push("'*:argument:_default'");
  return argumentsList.join(" ");
}

function renderOption(spec: CliOptionSpec): string[] {
  return (spec.flags ?? []).flatMap((flags) => {
    const valueMatch = /(?:<([^>]+)>|\[([^\]]+)\])/u.exec(flags);
    const valueName = (valueMatch?.[1] ?? valueMatch?.[2])?.replace(/\.\.\.$/u, "");
    const repeatPrefix = spec.repeatable ? "*" : "";
    const description = escapeZshText(spec.description);
    return flags
      .split(",")
      .map((part) => part.trim().split(/\s+/u)[0])
      .filter((name) => name.length > 0)
      .map((name) => {
        const optionValueName = name.startsWith("--no-") ? undefined : valueName;
        const completion = optionValueName
          ? `:${optionValueName}:${renderValueCompletion(spec.completion)}`
          : "";
        return shellQuote(`${repeatPrefix}${name}[${description}]${completion}`);
      });
  });
}

function renderHelpOption(): string {
  return "'(-h --help)'{-h,--help}'[Display help]'";
}

function renderCommandArgument(children: readonly string[]): string {
  return `'1:command:(${children.map(escapeZshText).join(" ")})'`;
}

function renderValueCompletion(spec: CliCompletionSpec | undefined): string {
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
  }
}

function mergeOptions(
  inherited: readonly CliOptionSpec[],
  local: readonly CliOptionSpec[],
): CliOptionSpec[] {
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
