import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";

export const sessionListOptionSpecs = defineOptions(
  {
    key: "global",
    flags: ["-g, --global"],
    description: "List sessions across all workspaces.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "all",
    flags: ["--all"],
    description: "Include sessions that are not currently running.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "names",
    flags: ["--names"],
    description: "Print only session names.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "json",
    flags: ["--json"],
    description: "Print sessions as JSON.",
    exposure: "cli",
    defaultValue: false,
  },
);

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
  const command = parent.command(options.commandName).description("List managed sessions");
  registerOptions(command, sessionListOptionSpecs);

  command.action(async (commandOptions) => {
    const resolved = resolveCommandOptions(commandOptions, sessionListOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: sessionListSchema,
        rawInput: resolved,
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionList,
      }),
    );
  });
  return command;
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
