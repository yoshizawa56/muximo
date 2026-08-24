import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

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
  const command = parent
    .command(`${options.commandName} <reference>`)
    .description("Clean up a managed session")
    .option("-g, --global")
    .option("--force");

  command.action(async (reference, commandOptions) => {
    context.report(
      await invokeCliHandler({
        schema: sessionCleanupSchema,
        rawInput: { ...commandOptions, reference },
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionCleanup,
      }),
    );
  });
  return command;
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
