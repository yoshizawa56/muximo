import { Command } from "commander";
import { registerOptions } from "../options/index.js";
import { registerCompletionCommand } from "./completion.js";
import { registerDaemonCommands } from "./daemon.js";
import { registerDevCommand } from "./dev.js";
import { registerDoctorCommand } from "./doctor.js";
import { globalOptionSpecs } from "./global.js";
import { registerPairCommand } from "./pair.js";
import { registerRunCommand } from "./run.js";
import { registerServeCommand } from "./serve.js";
import { registerSessionCommands } from "./session/index.js";
import { registerShellCommand } from "./shell.js";
import { registerTmuxCommands } from "./tmux.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { registerWorkspaceCommands } from "./workspace/index.js";

export function buildCliProgram(handlers: CliHandlers, context: CliCommandContext): Command {
  const program = new Command();
  program
    .name(context.rootCommand)
    .description("A mobile control room for tmux-hosted agents and shells.")
    .exitOverride()
    .enablePositionalOptions()
    .addHelpCommand()
    .configureOutput({ writeErr: () => undefined, writeOut: (value) => context.io.out.write(value) });
  registerOptions(program, globalOptionSpecs);

  program.action(() => {
    program.outputHelp();
    context.report(2);
  });

  registerRunCommand(program, handlers, context);
  registerShellCommand(program, handlers, context);
  registerTmuxCommands(program, handlers, context);
  registerWorkspaceCommands(program, handlers, context);
  registerSessionCommands(program, handlers, context);
  registerDoctorCommand(program, handlers, context);
  registerDaemonCommands(program, handlers, context);
  registerPairCommand(program, handlers, context);
  registerServeCommand(program, handlers, context);
  if (context.includeDevelopmentCommands) registerDevCommand(program, handlers, context);
  registerCompletionCommand(program, context);

  return program;
}
