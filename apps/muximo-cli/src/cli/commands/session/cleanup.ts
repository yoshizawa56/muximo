import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";

export const sessionCleanupOptionSpecs = defineOptions(
  {
    key: "global",
    flags: ["-g, --global"],
    description: "Clean up the session from the global session registry.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "force",
    flags: ["--force"],
    description: "Skip the cleanup confirmation prompt.",
    exposure: "cli",
    defaultValue: false,
  },
);

export const sessionCleanupSchema = z.object({
  global: z.boolean().default(false),
  force: z.boolean().default(false),
  reference: z.string().trim().min(1, { error: "cleanup requires a session name" }),
});

export type SessionCleanupCommandOptions = {
  commandName: "cleanup";
  commandPath: readonly string[];
};

export function registerSessionCleanupCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
  options: SessionCleanupCommandOptions,
): Command {
  const command = parent.command(`${options.commandName} <reference>`).description("Clean up a managed session");
  registerOptions(command, sessionCleanupOptionSpecs);

  command.action(async (reference, commandOptions) => {
    const resolved = resolveCommandOptions(commandOptions, sessionCleanupOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: sessionCleanupSchema,
        rawInput: { ...resolved, reference },
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionCleanup,
      }),
    );
  });
  return command;
}

export function registerNestedSessionCleanupCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  return registerSessionCleanupCommand(parent, handlers, context, {
    commandName: "cleanup",
    commandPath: ["session", "cleanup"],
  });
}

export function registerRootCleanupCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  return registerSessionCleanupCommand(parent, handlers, context, {
    commandName: "cleanup",
    commandPath: ["cleanup"],
  });
}
