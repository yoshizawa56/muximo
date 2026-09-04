import { Command } from "commander";
import { allCliBuildModes, type CliCommandRegistration, isAvailableIn } from "../build-mode.js";
import { registerOptions } from "../options/index.js";
import { registerCompletionCommand } from "./completion.js";
import { registerConfigCommand } from "./config.js";
import { registerDaemonCommands } from "./daemon.js";
import { registerDoctorCommand } from "./doctor.js";
import { globalOptionSpecs } from "./global.js";
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
    .addHelpCommand()
    .configureOutput({ writeErr: () => undefined, writeOut: (value) => context.io.out.write(value) });
  registerOptions(program, globalOptionSpecs, context.buildMode);

  program.action(() => {
    program.outputHelp();
    context.report(2);
  });

  const commands = [
    { availableIn: allCliBuildModes, register: () => registerRunCommand(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerShellCommand(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerTmuxCommands(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerWorkspaceCommands(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerSessionCommands(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerSessionAliases(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerDoctorCommand(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerDaemonCommands(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerPairCommand(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerServeCommand(program, handlers, context) },
    { availableIn: allCliBuildModes, register: () => registerCompletionCommand(program, context) },
    { availableIn: allCliBuildModes, register: () => registerConfigCommand(program, handlers, context) },
  ] satisfies readonly CliCommandRegistration[];
  for (const command of commands) {
    if (isAvailableIn(command.availableIn, context.buildMode)) command.register();
  }

  return program;
}
