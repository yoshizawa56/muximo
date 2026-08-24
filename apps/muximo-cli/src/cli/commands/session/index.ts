import type { Command } from "commander";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { registerNestedSessionCleanupCommand, registerRootCleanupCommand } from "./cleanup.js";
import { registerNestedSessionListCommand, registerRootListCommand } from "./list.js";
import { registerNestedSessionResumeCommand, registerRootResumeCommand } from "./resume.js";

export function registerSessionCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("session").description("Manage sessions");
  command.action(() => {
    context.report(2);
  });

  registerNestedSessionListCommand(command, handlers, context);
  registerNestedSessionResumeCommand(command, handlers, context);
  registerNestedSessionCleanupCommand(command, handlers, context);
  return command;
}

export function registerSessionAliases(parent: Command, handlers: CliHandlers, context: CliCommandContext): void {
  registerRootListCommand(parent, handlers, context);
  registerRootResumeCommand(parent, handlers, context);
  registerRootCleanupCommand(parent, handlers, context);
}
