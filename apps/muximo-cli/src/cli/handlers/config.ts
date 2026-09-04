import { readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import {
  diffMuximoConfig,
  getMuximoConfigValue,
  type MuximoConfig,
  type MuximoConfigChange,
  type MuximoConfigValue,
  parseMuximoConfigValue,
  readMuximoConfig,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "@muximo/profile";
import type { CliConfigInput, CliHandlers } from "../commands/types.js";

export type ConfigHandlerDependencies = {
  filePath: string;
  input: Readable;
  output: Writable;
  isInteractive?: boolean;
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
        const next = await promptMuximoConfig(current, dependencies.input, dependencies.output);
        writeMuximoConfig(dependencies.filePath, next);
        writeConfigChanges(dependencies.output, diffMuximoConfig(current, next));
        return 0;
      }
    }
  };
}

export async function promptMuximoConfig(
  current: MuximoConfig,
  input: Readable,
  output: Writable,
): Promise<MuximoConfig> {
  const prompt = createPromptReader(input, output);
  try {
    let config = structuredClone(current);

    config = await askConfigValue(
      config,
      "workspace.roots",
      "Workspace roots (comma-separated paths or a JSON array; use [] to clear)",
      config.workspace.roots,
      prompt,
      output,
    );

    config = await askConfigValue(
      config,
      "agents.enabled",
      "Enabled agent backends (comma-separated: codex, claude, opencode)",
      config.agents.enabled,
      prompt,
      output,
    );

    if (await askYesNo(prompt, output, "Configure agent details?", false)) {
      config = await askConfigValue(
        config,
        "agents.default",
        "Default agent backend (codex, claude, opencode, or none to clear)",
        config.agents.default,
        prompt,
        output,
      );
      for (const backend of config.agents.enabled) {
        config = await askConfigValue(
          config,
          `agents.executables.${backend}`,
          `${backend} executable (path or command)`,
          config.agents.executables[backend] ?? backend,
          prompt,
          output,
        );
      }
    }

    const tailscaleEnabled = await askYesNo(prompt, output, "Enable Tailscale Serve?", config.serve.tailscale.enabled);
    config = setMuximoConfigValue(config, "serve.tailscale.enabled", tailscaleEnabled);
    if (tailscaleEnabled) {
      config = await askConfigValue(
        config,
        "serve.tailscale.executable",
        "Tailscale executable (path or command)",
        config.serve.tailscale.executable,
        prompt,
        output,
      );
      config = await askConfigValue(
        config,
        "serve.tailscale.args",
        "Tailscale argv prefix (comma-separated or JSON array)",
        config.serve.tailscale.args,
        prompt,
        output,
      );
      config = await askConfigValue(
        config,
        "serve.tailscale.hostname",
        "Tailscale hostname (use none to resolve automatically)",
        config.serve.tailscale.hostname,
        prompt,
        output,
      );
      config = await askConfigValue(
        config,
        "serve.tailscale.externalPort",
        "Tailscale external port",
        config.serve.tailscale.externalPort,
        prompt,
        output,
      );
      config = await askConfigValue(
        config,
        "serve.tailscale.path",
        "Tailscale Serve path",
        config.serve.tailscale.path,
        prompt,
        output,
      );
    }

    if (await askYesNo(prompt, output, "Configure update settings?", false)) {
      config = await askConfigValue(
        config,
        "updates.policy",
        "Update policy (manual, notify, auto)",
        config.updates.policy,
        prompt,
        output,
      );
      config = await askConfigValue(
        config,
        "updates.channel",
        "Update channel (stable)",
        config.updates.channel,
        prompt,
        output,
      );
    }

    return config;
  } finally {
    prompt.close();
  }
}

export function completePath(line: string): [string[], string] {
  const separator = line.lastIndexOf("/");
  const typedDirectory = separator < 0 ? "." : line.slice(0, separator + 1);
  const typedName = separator < 0 ? line : line.slice(separator + 1);
  const directory = expandHome(typedDirectory);
  try {
    const entries = readdirSync(directory, { withFileTypes: true }) as Array<{
      name: string;
      isDirectory(): boolean;
    }>;
    const prefix = separator < 0 ? "" : line.slice(0, separator + 1);
    const matches = entries
      .filter((entry) => entry.name.startsWith(typedName))
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    return [matches, line];
  } catch {
    return [[], line];
  }
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
    output.write(`  ${change.key}: ${formatConfigValue(change.before)} -> ${formatConfigValue(change.after)}\n`);
  }
  output.write("Restart the daemon to apply these changes.\n");
}

function formatConfigValue(value: MuximoConfigValue): string {
  if (value === null) return "none";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

async function askText(prompt: PromptReader, label: string, defaultValue: string): Promise<string> {
  const renderedDefault = defaultValue === "" ? "empty" : defaultValue;
  const answer = await prompt.question(`${label} [${renderedDefault}]: `);
  return answer.trim() || defaultValue;
}

async function askYesNo(
  prompt: PromptReader,
  output: Writable,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  while (true) {
    const answer = (await askText(prompt, `${label} (yes/no)`, defaultValue ? "yes" : "no")).toLowerCase();
    if (answer === "y" || answer === "yes" || answer === "true") return true;
    if (answer === "n" || answer === "no" || answer === "false") return false;
    output.write("Invalid response: expected yes or no.\n");
  }
}

async function askConfigValue(
  config: MuximoConfig,
  key: string,
  label: string,
  defaultValue: MuximoConfigValue,
  prompt: PromptReader,
  output: Writable,
): Promise<MuximoConfig> {
  const defaultText = formatPromptValue(key, defaultValue);
  while (true) {
    const raw = await askText(prompt, label, defaultText);
    try {
      return setMuximoConfigValue(config, key, parsePromptConfigValue(key, raw));
    } catch (error) {
      output.write(`Invalid value for ${key}: ${errorMessage(error)}\n`);
    }
  }
}

type PromptReader = {
  question(prompt: string): Promise<string>;
  close(): void;
};

/**
 * Bun's readline promise implementation can lose buffered lines and spin when
 * a non-TTY stream writes input before the next question is registered. Keep
 * readline for real terminals, where line editing and path completion matter,
 * and use a small buffered reader for programmatic input.
 */
function createPromptReader(input: Readable, output: Writable): PromptReader {
  if (isTerminal(input, output)) {
    const readline = createInterface({ input, output, completer: completePath });
    return {
      question: (prompt) => readline.question(prompt),
      close: () => readline.close(),
    };
  }
  return new BufferedPromptReader(input, output);
}

class BufferedPromptReader implements PromptReader {
  private buffer = "";
  private readonly lines: string[] = [];
  private readonly waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    this.enqueueCompleteLines();
    this.drainLines();
  };
  private readonly onEnd = (): void => {
    this.enqueueCompleteLines();
    if (this.buffer.length > 0) this.lines.push(this.buffer.replace(/\r$/u, ""));
    this.buffer = "";
    this.closed = true;
    this.drainLines();
    this.rejectWaiters(new Error("interactive input ended before all prompts were answered"));
  };
  private readonly onError = (error: Error): void => {
    this.closed = true;
    this.rejectWaiters(new Error("interactive input failed", { cause: error }));
  };

  public constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.on("data", this.onData);
    input.once("end", this.onEnd);
    input.once("error", this.onError);
  }

  public question(prompt: string): Promise<string> {
    this.output.write(prompt);
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.closed) return Promise.reject(new Error("interactive input ended before the prompt was answered"));
    return new Promise<string>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drainLines();
    });
  }

  public close(): void {
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("error", this.onError);
    this.rejectWaiters(new Error("interactive prompt was closed"));
    this.closed = true;
  }

  private drainLines(): void {
    while (this.lines.length > 0 && this.waiters.length > 0) {
      const line = this.lines.shift();
      const waiter = this.waiters.shift();
      if (line === undefined || waiter === undefined) return;
      waiter.resolve(line);
    }
  }

  private enqueueCompleteLines(): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      this.lines.push(this.buffer.slice(0, newline).replace(/\r$/u, ""));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  private rejectWaiters(error: Error): void {
    while (this.waiters.length > 0) this.waiters.shift()?.reject(error);
  }
}

function isTerminal(input: Readable, output: Writable): boolean {
  return (
    (input as Readable & { isTTY?: boolean }).isTTY === true &&
    (output as Writable & { isTTY?: boolean }).isTTY === true
  );
}

function parsePromptConfigValue(key: string, raw: string): MuximoConfigValue {
  if ((key === "agents.default" || key === "serve.tailscale.hostname") && raw.trim() === "") return null;
  return parseMuximoConfigValue(key, [raw]);
}

function formatPromptValue(key: string, value: MuximoConfigValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return key === "serve.tailscale.args" ? JSON.stringify(value) : value.join(", ");
  return String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? ".";
  if (value.startsWith("~/")) return `${process.env.HOME ?? "."}/${value.slice(2)}`;
  return value;
}
