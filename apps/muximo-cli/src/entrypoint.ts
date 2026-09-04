import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DaemonHealthError } from "@muximo/application";
import { defaultLogFile } from "@muximo/infrastructure/cli-client";
import type { MuximodProcessCommand } from "@muximo/muximod/client";
import { getProfile, resolveProfileName } from "@muximo/profile";
import { createCliApp } from "./cli/app.js";
import type { CliBuildMode } from "./cli/build-mode.js";
import { globalOptionSpecs } from "./cli/commands/global.js";
import type { CliHandlers } from "./cli/commands/types.js";
import { createCliComposition } from "./cli/compose.js";
import { assertAvailableOptions, readOptionValues, scanRootOptions } from "./cli/options/index.js";
import { presentDaemonError } from "./cli/presenters/daemon.js";
import { resolveMuximoCliRuntimeOptions } from "./cli/runtime.js";

const sourceRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export type CliEntrypointOptions = {
  buildMode?: CliBuildMode;
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  out?: Writable;
  err?: Writable;
  muximodProcess?: MuximodProcessCommand;
};

/** Process boundary: argv/env/I/O invocation and exit status only. */
export async function runMuximoCli(args: readonly string[], options: CliEntrypointOptions): Promise<number> {
  const io = {
    out: options.out ?? process.stdout,
    err: options.err ?? process.stderr,
  };
  const inputEnvironment = { ...process.env, ...options.env };
  const buildMode = options.buildMode ?? "development";
  let environment = inputEnvironment;
  let composition: ReturnType<typeof createCliComposition> | undefined;

  try {
    assertAvailableOptions(args, globalOptionSpecs, buildMode);
    if (isParserOnlyInvocation(args, buildMode)) {
      const app = createCliApp({
        io,
        cwd: process.cwd(),
        environment: inputEnvironment,
        buildMode,
        handlers: createNoopHandlers(),
      });
      return await app.execute(args);
    }

    const rootOptions = scanRootOptions(args, globalOptionSpecs, buildMode);
    const rawGlobalOptions = readOptionValues(rootOptions.options, globalOptionSpecs, buildMode);
    const profile = getProfile({
      name:
        buildMode === "development"
          ? resolveProfileName(rawGlobalOptions.environment ?? inputEnvironment.MUXIMO_ENV)
          : undefined,
      repositoryRoot: sourceRepositoryRoot,
      baseEnvironment: inputEnvironment,
    });
    const runtimeResolution = resolveMuximoCliRuntimeOptions({
      raw: rawGlobalOptions,
      args: rootOptions.options,
      environment: profile.environment,
      cwd: process.cwd(),
      buildMode,
    });
    environment = runtimeResolution.environment;
    composition = createCliComposition({
      environment,
      input: options.input,
      io,
      runtime: runtimeResolution.runtime,
      muximodProcess: options.muximodProcess,
    });
    return await composition.execute(args);
  } catch (error) {
    return reportEntrypointError(io.err, error, environment);
  } finally {
    composition?.close();
  }
}

function isCompletionInvocation(args: readonly string[], buildMode: CliBuildMode): boolean {
  const commandIndex = firstCommandIndex(args, buildMode);
  return commandIndex >= 0 && args[commandIndex] === "completion";
}

function isParserOnlyInvocation(args: readonly string[], buildMode: CliBuildMode): boolean {
  const commandIndex = firstCommandIndex(args, buildMode);
  const parserArguments = commandIndex < 0 ? args : args.slice(0, commandIndex);
  const hasCommand = commandIndex >= 0;
  return (
    args.length === 0 ||
    !hasCommand ||
    isCompletionInvocation(args, buildMode) ||
    parserArguments.some((argument) => argument === "-h" || argument === "--help")
  );
}

function firstCommandIndex(args: readonly string[], buildMode: CliBuildMode): number {
  return scanRootOptions(args, globalOptionSpecs, buildMode).commandIndex;
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
    config: async () => 0,
  };
}
