import type { Readable, Writable } from "node:stream";
import { DaemonHealthError } from "@muximo/application";
import { defaultLogFile } from "@muximo/infrastructure/cli-client";
import { createCliApp } from "./cli/app.js";
import { globalOptionSpecs } from "./cli/commands/global.js";
import type { CliHandlers } from "./cli/commands/types.js";
import { createCliComposition } from "./cli/compose.js";
import { resolveCliOptions } from "./cli/options/index.js";
import { presentDaemonError } from "./cli/presenters/daemon.js";
import { type MuximoEnvironmentName, muximoEnvironmentNames, resolveMuximoEnvironmentProfile } from "./environment.js";

export type CliEntrypointOptions = {
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  out?: Writable;
  err?: Writable;
};

/** Process boundary: argv/env/I/O invocation and exit status only. */
export async function runMuximoCli(args: readonly string[], options: CliEntrypointOptions): Promise<number> {
  const io = {
    out: options.out ?? process.stdout,
    err: options.err ?? process.stderr,
  };
  const inputEnvironment = { ...process.env, ...options.env };

  if (isParserOnlyInvocation(args)) {
    const app = createCliApp({
      io,
      cwd: process.cwd(),
      environment: inputEnvironment,
      handlers: createNoopHandlers(),
    });
    try {
      return await app.execute(args);
    } catch (error) {
      return reportEntrypointError(io.err, error, inputEnvironment);
    }
  }

  let environment = inputEnvironment;
  let composition: ReturnType<typeof createCliComposition> | undefined;
  try {
    const rootArgs = rootOptionArguments(args);
    const globalOptions = resolveCliOptions(readRootOptionValues(rootArgs), globalOptionSpecs, {
      args: rootArgs,
      environment: inputEnvironment,
    });
    const environmentName = resolveEnvironmentName(globalOptions.environment);
    environment = resolveMuximoEnvironmentProfile({
      name: environmentName,
      cwd: process.cwd(),
      environment,
    }).environment;
    composition = createCliComposition({
      environment,
      input: options.input,
      io,
      logLevel: globalOptions.verbose === true ? "debug" : undefined,
    });
    return await composition.execute(args);
  } catch (error) {
    return reportEntrypointError(io.err, error, environment);
  } finally {
    composition?.close();
  }
}

function resolveEnvironmentName(value: unknown): MuximoEnvironmentName {
  if (typeof value === "string" && (muximoEnvironmentNames as readonly string[]).includes(value)) {
    return value as MuximoEnvironmentName;
  }
  throw new Error("--env must be local, stg, or prod");
}

function isCompletionInvocation(args: readonly string[]): boolean {
  const commandIndex = firstCommandIndex(args);
  return commandIndex >= 0 && args[commandIndex] === "completion";
}

function isParserOnlyInvocation(args: readonly string[]): boolean {
  const commandIndex = firstCommandIndex(args);
  const parserArguments = commandIndex < 0 ? args : args.slice(0, commandIndex);
  const hasCommand = commandIndex >= 0;
  return (
    args.length === 0 ||
    !hasCommand ||
    isCompletionInvocation(args) ||
    parserArguments.some((argument) => argument === "-h" || argument === "--help")
  );
}

function rootOptionArguments(args: readonly string[]): readonly string[] {
  const commandIndex = firstCommandIndex(args);
  return commandIndex < 0 ? args : args.slice(0, commandIndex);
}

function firstCommandIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return -1;
    if (argument === "--env") {
      index += 1;
      continue;
    }
    if (argument?.startsWith("--env=")) continue;
    if (argument?.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function readRootOptionValues(args: readonly string[]): Record<string, unknown> {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--env") return { environment: args[index + 1] };
    if (argument?.startsWith("--env=")) return { environment: argument.slice("--env=".length) };
  }
  return {};
}

function reportEntrypointError(err: Writable, error: unknown, environment?: NodeJS.ProcessEnv): number {
  if (error instanceof DaemonHealthError) {
    return presentDaemonError(
      error,
      { out: err, err },
      environment === undefined ? undefined : defaultLogFile(environment),
    );
  }
  err.write(`[muximo-cli] error: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

function createNoopHandlers(): CliHandlers {
  return {
    run: async () => 0,
    shell: async () => 0,
    tmuxNewSession: async () => 0,
    tmuxManageSession: async () => 0,
    sessionList: async () => 0,
    sessionResume: async () => 0,
    sessionCleanup: async () => 0,
    doctor: async () => 0,
    daemon: async () => 0,
    pair: async () => 0,
    serve: async () => 0,
    workspaceList: async () => 0,
    workspaceAdd: async () => 0,
    workspaceUpdate: async () => 0,
    workspaceDelete: async () => 0,
  };
}
