import { buildCliProgram } from "./commands/program.js";
import type { CliAppDeps, CliCommandContext } from "./commands/types.js";
import { reportCommanderError } from "./commands/validation.js";

export type CliApp = {
  execute(args: readonly string[]): Promise<number>;
};

export function createCliApp(deps: CliAppDeps): CliApp {
  const rootCommand = deps.rootCommand ?? "muximo";

  return {
    async execute(args) {
      let status = 0;
      const context: CliCommandContext = {
        io: deps.io,
        cwd: deps.cwd,
        args,
        environment: deps.environment,
        buildMode: deps.buildMode ?? "development",
        runtime: deps.runtime,
        rootCommand,
        report: (value) => {
          status = value;
        },
        lifecycle: deps.lifecycle,
      };
      const program = buildCliProgram(deps.handlers, context);
      try {
        await program.parseAsync([...args], { from: "user" });
      } catch (error) {
        if (isCommanderError(error)) {
          if (error.code === "commander.helpDisplayed" || error.code === "commander.help") return 0;
          return reportCommanderError(context, commandPath(args), error.message);
        }
        throw error;
      }
      return status;
    },
  };
}

function isCommanderError(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === "string" &&
    (error as Error & { code: string }).code.startsWith("commander.")
  );
}

function commandPath(args: readonly string[]): readonly string[] {
  return args.filter((argument) => argument !== "--" && !argument.startsWith("-"));
}

export type { CliAppDeps } from "./commands/types.js";
