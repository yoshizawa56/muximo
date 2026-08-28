import type { Readable, Writable } from "node:stream";
import { createCliApp } from "./cli/app.js";
import { globalOptionSpecs } from "./cli/commands/global.js";
import type { CliHandlers } from "./cli/commands/types.js";
import { createCliComposition } from "./cli/compose.js";
import { resolveCliOptions } from "./cli/options/index.js";

export type CliMuximodLaunchOptions = { schemaMode: "migrate" } | { schemaMode: "push"; baseInstanceDir: string };

export type CliEntrypointOptions = {
  includeDevelopmentCommands: boolean;
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  out?: Writable;
  err?: Writable;
  muximod?: CliMuximodLaunchOptions;
};

/** Process boundary: argv/env/I/O invocation and exit status only. */
export async function runMuximoCli(args: readonly string[], options: CliEntrypointOptions): Promise<number> {
  const io = {
    out: options.out ?? process.stdout,
    err: options.err ?? process.stderr,
  };
  const environment = { ...process.env, ...options.env };

  if (isParserOnlyInvocation(args)) {
    const app = createCliApp({
      io,
      cwd: process.cwd(),
      environment,
      handlers: createNoopHandlers(),
      includeDevelopmentCommands: options.includeDevelopmentCommands,
    });
    try {
      return await app.execute(args);
    } catch (error) {
      return reportEntrypointError(io.err, error);
    }
  }

  const globalOptions = resolveCliOptions({}, globalOptionSpecs, {
    args: rootOptionArguments(args),
    environment,
  });
  const composition = createCliComposition({
    includeDevelopmentCommands: options.includeDevelopmentCommands,
    muximodSchemaMode: options.muximod?.schemaMode ?? "migrate",
    muximodBaseInstanceDir: options.muximod?.schemaMode === "push" ? options.muximod.baseInstanceDir : undefined,
    env: environment,
    input: options.input,
    io,
    logLevel: globalOptions.verbose === true ? "debug" : undefined,
  });
  try {
    return await composition.execute(args);
  } catch (error) {
    return reportEntrypointError(io.err, error);
  } finally {
    composition.close();
  }
}

function isCompletionInvocation(args: readonly string[]): boolean {
  return args.find((argument) => argument !== "--" && !argument.startsWith("-")) === "completion";
}

function isParserOnlyInvocation(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const parserArguments = end < 0 ? args : args.slice(0, end);
  const hasCommand = args.some((argument) => argument !== "--" && !argument.startsWith("-"));
  return (
    args.length === 0 ||
    !hasCommand ||
    isCompletionInvocation(args) ||
    parserArguments.some((argument) => argument === "-h" || argument === "--help")
  );
}

function rootOptionArguments(args: readonly string[]): readonly string[] {
  const commandIndex = args.findIndex((argument) => argument !== "--" && !argument.startsWith("-"));
  return commandIndex < 0 ? args : args.slice(0, commandIndex);
}

function reportEntrypointError(err: Writable, error: unknown): number {
  err.write(`muximo: ${error instanceof Error ? error.message : String(error)}\n`);
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
    dev: async () => 0,
    workspaceList: async () => 0,
    workspaceAdd: async () => 0,
    workspaceUpdate: async () => 0,
    workspaceDelete: async () => 0,
  };
}
