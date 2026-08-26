import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";

export const sessionResumeOptionSpecs = defineOptions({
  key: "global",
  flags: ["-g, --global"],
  description: "Resume the session from the global session registry.",
  exposure: "cli",
  defaultValue: false,
});

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
    .description("Resume a managed session");
  registerOptions(command, sessionResumeOptionSpecs);
  command.allowUnknownOption(true);

  command.action(async (reference, backendArgs, commandOptions) => {
    const resolved = resolveCommandOptions(commandOptions, sessionResumeOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: sessionResumeSchema,
        rawInput: { ...resolved, reference, backendArgs: backendArgs ?? [] },
        commandPath: options.commandPath,
        context,
        handler: handlers.sessionResume,
      }),
    );
  });
  return command;
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
