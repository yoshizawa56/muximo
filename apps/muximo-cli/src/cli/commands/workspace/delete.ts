import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

export const workspaceDeleteOptionSpecs = defineOptions(
  {
    key: "force",
    flags: ["--force"],
    description: "Skip deletion confirmation when supported by the workspace handler.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "yes",
    flags: ["--yes"],
    description: "Assume yes when confirmation is requested.",
    exposure: "cli",
    defaultValue: false,
  },
);

export const workspaceDeleteSchema = z.object({
  selector: z.string().trim().min(1, { error: "workspace delete requires a workspace selector" }),
});

export function registerWorkspaceDeleteCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = parent.command("delete <selector>").description("Unregister a workspace");
  registerOptions(command, workspaceDeleteOptionSpecs);
  command.action(async (selector, _options) => {
    context.report(
      await invokeCliHandler({
        schema: workspaceDeleteSchema,
        rawInput: { selector },
        commandPath: ["workspace", "delete"],
        context,
        handler: handlers.workspaceDelete,
      }),
    );
  });
  return command;
}
