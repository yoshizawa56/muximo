import type { Readable, Writable } from "node:stream";
import { DaemonHealthError } from "@muximo/application";
import { defaultLogFile } from "@muximo/infrastructure/cli-client";
import { getProfile, resolveProfileName } from "@muximo/profile";
import { createCliApp } from "./cli/app.js";
import { globalOptionSpecs } from "./cli/commands/global.js";
import type { CliHandlers } from "./cli/commands/types.js";
import { createCliComposition } from "./cli/compose.js";
import { readOptionValues, scanRootOptions } from "./cli/options/index.js";
import { presentDaemonError } from "./cli/presenters/daemon.js";
import { resolveMuximoCliRuntimeOptions } from "./cli/runtime.js";

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
    const rootOptions = scanRootOptions(args, globalOptionSpecs);
    const rawGlobalOptions = readOptionValues(rootOptions.options, globalOptionSpecs);
    const profile = getProfile({
      name: resolveProfileName(rawGlobalOptions.environment ?? inputEnvironment.MUXIMO_ENV),
      cwd: process.cwd(),
      baseEnvironment: inputEnvironment,
    });
    const runtimeResolution = resolveMuximoCliRuntimeOptions({
      raw: rawGlobalOptions,
      args: rootOptions.options,
      environment: profile.environment,
      cwd: process.cwd(),
    });
    environment = runtimeResolution.environment;
    composition = createCliComposition({
      environment,
      input: options.input,
      io,
      runtime: runtimeResolution.runtime,
    });
    return await composition.execute(args);
  } catch (error) {
    return reportEntrypointError(io.err, error, environment);
  } finally {
    composition?.close();
  }
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

function firstCommandIndex(args: readonly string[]): number {
  return scanRootOptions(args, globalOptionSpecs).commandIndex;
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
