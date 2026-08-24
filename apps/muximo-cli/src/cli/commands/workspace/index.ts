import type { Command } from "commander";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { registerWorkspaceDeleteCommand } from "./delete.js";
import { registerWorkspaceListCommand } from "./list.js";
import { registerWorkspaceAddCommand, registerWorkspaceUpdateCommand } from "./mutation.js";

export function registerWorkspaceCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("workspace").description("Manage workspaces");
  command.action(() => {
    context.report(2);
  });
  registerWorkspaceListCommand(command, handlers, context);
  registerWorkspaceAddCommand(command, handlers, context);
  registerWorkspaceAddCommand(command, handlers, context, "register");
  registerWorkspaceUpdateCommand(command, handlers, context);
  registerWorkspaceDeleteCommand(command, handlers, context);
  return command;
}
