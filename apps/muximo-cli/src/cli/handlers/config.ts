import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import {
  diffMuximoConfig,
  formatMuximoConfigValue,
  getMuximoConfigValue,
  type MuximoConfig,
  type MuximoConfigChange,
  type MuximoConfigValue,
  parseMuximoConfigValue,
  readMuximoConfig,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "@muximo/instance-contract";
import { type ConfigPrompt, createInquirerConfigPrompt } from "../adapters/inquirer-config-prompt.js";
import type { CliConfigInput, CliHandlers } from "../commands/types.js";
import { runMuximoConfigInit } from "../config-init.js";

export type ConfigHandlerDependencies = {
  filePath: string;
  input: Readable;
  output: Writable;
  isInteractive?: boolean;
  prompt?: ConfigPrompt;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export function createConfigHandler(dependencies: ConfigHandlerDependencies): CliHandlers["config"] {
  return async (input) => {
    switch (input.command) {
      case "path":
        dependencies.output.write(`${dependencies.filePath}\n`);
        return 0;
      case "show":
        writeJson(dependencies.output, readMuximoConfig(dependencies.filePath));
        return 0;
      case "import": {
        const source = input.source?.trim();
        if (!source) throw new Error('a source file is required for "import"');
        if (!existsSync(source)) throw new Error(`configuration file was not found: ${source}`);
        const current = readMuximoConfig(dependencies.filePath);
        const next = readMuximoConfig(source);
        writeMuximoConfig(dependencies.filePath, next);
        writeConfigChanges(dependencies.output, diffMuximoConfig(current, next));
        return 0;
      }
      case "get": {
        const key = requireKey(input);
        writeJson(dependencies.output, getMuximoConfigValue(readMuximoConfig(dependencies.filePath), key));
        return 0;
      }
      case "set": {
        const key = requireKey(input);
        const current = readMuximoConfig(dependencies.filePath);
        const next = setMuximoConfigValue(current, key, parseMuximoConfigValue(key, input.values));
        writeMuximoConfig(dependencies.filePath, next);
        writeConfigChanges(dependencies.output, diffMuximoConfig(current, next));
        return 0;
      }
      case "init": {
        const interactive =
          dependencies.isInteractive ??
          (dependencies.input === process.stdin &&
            process.stdin.isTTY === true &&
            dependencies.output === process.stdout);
        if (!interactive) {
          throw new Error('config init requires an interactive terminal; use "muximo config set" instead');
        }
        const current = readMuximoConfig(dependencies.filePath);
        const prompt = dependencies.prompt ?? createInquirerConfigPrompt(dependencies.input, dependencies.output);
        const next = await promptMuximoConfig(current, {
          prompt,
          output: dependencies.output,
          cwd: dependencies.cwd ?? process.cwd(),
          environment: dependencies.environment ?? process.env,
          platform: dependencies.platform ?? process.platform,
        });
        if (next === null) {
          dependencies.output.write("Configuration update cancelled.\n");
          return 0;
        }
        writeMuximoConfig(dependencies.filePath, next);
        writeConfigChanges(dependencies.output, diffMuximoConfig(current, next));
        return 0;
      }
    }
  };
}

export function promptMuximoConfig(
  current: MuximoConfig,
  options: {
    prompt: ConfigPrompt;
    output: Writable;
    cwd: string;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  },
): Promise<MuximoConfig | null> {
  return runMuximoConfigInit(current, options);
}

function requireKey(input: CliConfigInput): string {
  const key = input.key?.trim();
  if (!key) throw new Error(`a config key is required for "${input.command}"`);
  return key;
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeConfigChanges(output: Writable, changes: readonly MuximoConfigChange[]): void {
  if (changes.length === 0) {
    output.write("No configuration changes.\n");
    return;
  }
  output.write("Changed configuration values:\n");
  for (const change of changes) {
    output.write(
      `  ${change.key}: ${formatConfigValue(change.key, change.before)} -> ${formatConfigValue(change.key, change.after)}\n`,
    );
  }
  output.write("Restart the daemon to apply these changes.\n");
}

function formatConfigValue(key: string, value: MuximoConfigValue): string {
  return formatMuximoConfigValue(key, value);
}
