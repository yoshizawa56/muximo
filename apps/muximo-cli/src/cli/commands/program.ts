import { Command } from "commander";
import { registerDaemonCommands } from "./daemon.js";
import { registerDevCommand } from "./dev.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerPairCommand } from "./pair.js";
import { registerRunCommand } from "./run.js";
import { registerServeCommand } from "./serve.js";
import { registerSessionAliases, registerSessionCommands } from "./session/index.js";
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
    .option("-v, --verbose", "Show detailed diagnostics on the attached terminal.")
    .addHelpCommand()
    .configureOutput({ writeErr: () => undefined, writeOut: (value) => context.io.out.write(value) });

  program.action(() => {
    context.io.out.write(program.helpInformation());
    context.report(2);
  });

  registerRunCommand(program, handlers, context);
  registerShellCommand(program, handlers, context);
  registerTmuxCommands(program, handlers, context);
  registerWorkspaceCommands(program, handlers, context);
  registerSessionCommands(program, handlers, context);
  registerSessionAliases(program, handlers, context);
  registerDoctorCommand(program, handlers, context);
  registerDaemonCommands(program, handlers, context);
  registerPairCommand(program, handlers, context);
  registerServeCommand(program, handlers, context);
  registerDevCommand(program, handlers, context);

  return program;
}
