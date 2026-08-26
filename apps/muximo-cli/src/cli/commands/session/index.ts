import type { Command } from "commander";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { registerNestedSessionCleanupCommand } from "./cleanup.js";
import { registerNestedSessionListCommand } from "./list.js";
import { registerNestedSessionResumeCommand } from "./resume.js";

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
