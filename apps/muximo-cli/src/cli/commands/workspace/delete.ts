import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

export const workspaceDeleteSchema = z.object({
  selector: z.string().trim().min(1, { error: "workspace delete requires a workspace selector" }),
});

export function registerWorkspaceDeleteCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = parent
    .command("delete <selector>")
    .description("Unregister a workspace")
    .option("--force")
    .option("--yes");
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
