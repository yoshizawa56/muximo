import { agentBackendSchema } from "@muximo/domain";
import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const optionalWorktreeSchema = z.union([z.string().min(1), z.boolean()]).optional();
const optionalHookSchema = z.union([z.string(), z.literal(false)]).optional();

export const runSchema = z
  .object({
    backend: agentBackendSchema,
    name: z.string().min(1).optional(),
    worktree: optionalWorktreeSchema,
    worktreeRoot: z.string().optional(),
    setupHook: optionalHookSchema,
    cleanupHook: optionalHookSchema,
    backendArgs: z.array(z.string()).default([]),
    setupTask: z.union([z.string(), z.literal(true)]).optional(),
    cleanupTask: z.union([z.string(), z.literal(true)]).optional(),
  })
  .superRefine((input, context) => {
    if (input.setupTask !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["setupTask"],
        message: "--setup-task is no longer supported; use workspace hooks or --setup-hook",
      });
    }
    if (input.cleanupTask !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["cleanupTask"],
        message: "--cleanup-task is no longer supported; use workspace hooks or --cleanup-hook",
      });
    }
  })
  .transform((input) => {
    const worktreeName = typeof input.worktree === "string" ? input.worktree : undefined;
    return {
      backend: input.backend,
      name: input.name ?? worktreeName,
      useWorktree: input.worktree === true || typeof input.worktree === "string",
      worktreeRoot: input.worktreeRoot,
      setupHook: input.setupHook === false ? undefined : input.setupHook,
      cleanupHook: input.cleanupHook === false ? undefined : input.cleanupHook,
      setupHookExplicit: input.setupHook !== undefined,
      cleanupHookExplicit: input.cleanupHook !== undefined,
      backendArgs: input.backendArgs,
    };
  });

export function registerRunCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent
    .command("run <backend> [backendArgs...]")
    .description("Run an agent backend")
    .option("-n, --name <name>")
    .option("-w, --worktree [name]")
    .option("--no-worktree")
    .option("--worktree-root <path>")
    .option("--setup-hook <path>")
    .option("--no-setup-hook")
    .option("--cleanup-hook <path>")
    .option("--no-cleanup-hook")
    .option("--setup-task [value]")
    .option("--cleanup-task [value]")
    .allowUnknownOption(true);

  command.action(async (backend, backendArgs, options) => {
    context.report(
      await invokeCliHandler({
        schema: runSchema,
        rawInput: { ...options, backend, backendArgs },
        commandPath: ["run"],
        context,
        handler: handlers.run,
      }),
    );
  });
  return command;
}
