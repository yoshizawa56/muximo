import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

export const shellOptionSpecs = defineOptions(
  {
    key: "shell",
    flags: ["--shell <path>"],
    description: "Shell executable to launch.",
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "exitAfterCommand",
    flags: ["--exit-after-command"],
    description: "Exit after the command passed after -- finishes.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "worktree",
    flags: ["-w, --worktree [name]", "--no-worktree"],
    description: "Run the shell in a managed worktree.",
    flagDescriptions: {
      "--no-worktree": "Run the shell in the current workspace.",
    },
    exposure: "cli",
  },
);

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
  const command = parent.command("shell [command...]").description("Open a shell in the current workspace");
  registerOptions(command, shellOptionSpecs, context.buildMode);
  command.allowExcessArguments(true);

  command.action(async (commandArgs, options) => {
    const resolved = resolveCommandOptions(options, shellOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: shellSchema,
        rawInput: { ...resolved, command: commandArgs ?? [] },
        commandPath: ["shell"],
        context,
        handler: handlers.shell,
      }),
    );
  });
  return command;
}
