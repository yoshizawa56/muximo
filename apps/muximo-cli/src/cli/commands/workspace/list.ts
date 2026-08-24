import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";

export const workspaceListOptionSpecs = defineOptions({
  key: "json",
  flags: ["--json"],
  description: "Print workspaces as JSON.",
  exposure: "cli",
  defaultValue: false,
});

export const workspaceListSchema = z.object({
  json: z.boolean().default(false),
});

export function registerWorkspaceListCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = parent.command("list").description("List registered workspaces");
  registerOptions(command, workspaceListOptionSpecs);
  command.action(async (options) => {
    const resolved = resolveCommandOptions(options, workspaceListOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: workspaceListSchema,
        rawInput: resolved,
        commandPath: ["workspace", "list"],
        context,
        handler: handlers.workspaceList,
      }),
    );
  });
  return command;
}
