import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

export const sessionListSchema = z
  .object({
    global: z.boolean().default(false),
    names: z.boolean().default(false),
    json: z.boolean().default(false),
    all: z.boolean().default(false),
  })
  .superRefine((input, context) => {
    if (input.names && input.json) {
      context.addIssue({
        code: "custom",
        path: ["json"],
        message: "--names and --json cannot be combined",
      });
    }
  });

export type SessionListCommandOptions = {
  commandName: "list";
  commandPath: readonly string[];
};

export function registerSessionListCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
  options: SessionListCommandOptions,
): Command {
  const command = parent
    .command(options.commandName)
    .description("List managed sessions")
    .option("-g, --global")
    .option("--all")
    .option("--names")
    .option("--json");

  command.action(async (commandOptions) => {
    context.report(
      await invokeCliHandler({
        schema: sessionListSchema,
        rawInput: commandOptions,
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionList,
      }),
    );
  });
  return command;
}

export function registerRootListCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  return registerSessionListCommand(parent, handlers, context, {
    commandName: "list",
    commandPath: ["list"],
  });
}

export function registerNestedSessionListCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  return registerSessionListCommand(parent, handlers, context, {
    commandName: "list",
    commandPath: ["session", "list"],
  });
}
