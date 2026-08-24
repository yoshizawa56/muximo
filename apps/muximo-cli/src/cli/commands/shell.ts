import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const worktreeSchema = z.union([z.string().min(1), z.boolean()]).optional();

export const shellSchema = z
  .object({
    shell: z.string().min(1).optional(),
    command: z.array(z.string()).default([]),
    exitAfterCommand: z.boolean().default(false),
    worktree: worktreeSchema,
  })
  .superRefine((input, context) => {
    if (input.exitAfterCommand && input.command.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["command"],
        message: "--exit-after-command requires a command after --",
      });
    }
  })
  .transform((input) => ({
    shell: input.shell,
    command: input.command,
    exitAfterCommand: input.exitAfterCommand,
    worktree: input.worktree === true || typeof input.worktree === "string",
    worktreeName: typeof input.worktree === "string" ? input.worktree : null,
  }));

export function registerShellCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent
    .command("shell [command...]")
    .description("Open a shell in the current workspace")
    .option("--shell <path>")
    .option("--exit-after-command")
    .option("-w, --worktree [name]")
    .option("--no-worktree")
    .allowExcessArguments(true);

  command.action(async (commandArgs, options) => {
    context.report(
      await invokeCliHandler({
        schema: shellSchema,
        rawInput: { ...options, command: commandArgs ?? [] },
        commandPath: ["shell"],
        context,
        handler: handlers.shell,
      }),
    );
  });
  return command;
}
