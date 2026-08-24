import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler } from "../validation.js";

export const sessionResumeSchema = z.object({
  global: z.boolean().default(false),
  reference: z.string().trim().min(1, { error: "resume requires a session name" }),
  backendArgs: z.array(z.string()).default([]),
});

export type SessionResumeCommandOptions = {
  commandName: "resume";
  commandPath: readonly string[];
};

export function registerSessionResumeCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
  options: SessionResumeCommandOptions,
): Command {
  const command = parent
    .command(`${options.commandName} <reference> [backendArgs...]`)
    .description("Resume a managed session")
    .option("-g, --global")
    .allowUnknownOption(true);

  command.action(async (reference, backendArgs, commandOptions) => {
    context.report(
      await invokeCliHandler({
        schema: sessionResumeSchema,
        rawInput: { ...commandOptions, reference, backendArgs: backendArgs ?? [] },
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionResume,
      }),
    );
  });
  return command;
}

export function registerRootResumeCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  return registerSessionResumeCommand(parent, handlers, context, {
    commandName: "resume",
    commandPath: ["resume"],
  });
}

export function registerNestedSessionResumeCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  return registerSessionResumeCommand(parent, handlers, context, {
    commandName: "resume",
    commandPath: ["session", "resume"],
  });
}
