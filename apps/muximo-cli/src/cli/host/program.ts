import { Command } from "commander";

import type { MuximoCommand } from "./muximo-command.js";

/**
 * Declarative command registry for the muximo CLI.
 *
 * Commander owns dispatch and help; each action delegates to the context's
 * group handlers so option semantics stay byte-identical during migration.
 */
export function buildProgram(command: MuximoCommand, report: (status: number) => void): Command {
  const program = new Command();
  program
    .name("muximo")
    .exitOverride()
    .allowUnknownOption(true)
    .helpOption(false)
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });

  program
    .command("run")
    .argument("[backend]")
    .argument("[args...]")
    .allowUnknownOption(true)
    .action(async (backend, args) => {
      report(await command.runCommandEntry(backend, args));
    });

  program
    .command("shell")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      report(await command.shellCommandEntry());
    });

  program
    .command("tmux")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      report(await command.tmuxCommandEntry());
    });

  program
    .command("workspace")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      command.ensureDatabaseEntry();
      report(await command.workspaceCommandEntry());
    });

  program
    .command("session")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      command.ensureDatabaseEntry();
      report(await command.sessionCommandEntry());
    });

  program
    .command("resume")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      command.ensureDatabaseEntry();
      report(await command.resumeCommandEntry());
    });

  program
    .command("list")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      command.ensureDatabaseEntry();
      report(await command.listCommandEntry());
    });

  program
    .command("cleanup")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      command.ensureDatabaseEntry();
      report(await command.cleanupCommandEntry());
    });

  program
    .command("doctor")
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async () => {
      report(await command.doctorCommandEntry());
    });

  return program;
}
