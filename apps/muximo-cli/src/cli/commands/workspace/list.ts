import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

export const workspaceListSchema = z.object({
  json: z.boolean().default(false),
});

export function registerWorkspaceListCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = parent.command("list").description("List registered workspaces").option("--json");
  command.action(async (options) => {
    context.report(
      await invokeCliHandler({
        schema: workspaceListSchema,
        rawInput: options,
        commandPath: ["workspace", "list"],
        context,
        handler: handlers.workspaceList,
      }),
    );
  });
  return command;
}
