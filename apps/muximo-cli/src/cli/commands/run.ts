import { agentBackendSchema } from "@muximo/domain";
import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

export const runOptionSpecs = defineOptions(
  {
    key: "name",
    flags: ["-n, --name <name>"],
    description: "Name the managed session.",
    exposure: "cli",
  },
  {
    key: "workspace",
    flags: ["--workspace <name-or-path>"],
    description: "Select a registered workspace by name or path.",
    exposure: "cli",
  },
  {
    key: "worktree",
    flags: ["-w, --worktree [name]", "--no-worktree"],
    description: "Run the session in a managed worktree.",
    flagDescriptions: {
      "--no-worktree": "Run the session in the current workspace.",
    },
    exposure: "cli",
  },
  {
    key: "worktreeRoot",
    flags: ["--worktree-root <path>"],
    description: "Root directory in which managed worktrees are created.",
    exposure: "cli",
    completion: { kind: "directory" },
  },
  {
    key: "setupHook",
    flags: ["--setup-hook <path>", "--no-setup-hook"],
    description: "Override the workspace setup hook.",
    flagDescriptions: {
      "--no-setup-hook": "Disable the workspace setup hook.",
    },
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "cleanupHook",
    flags: ["--cleanup-hook <path>", "--no-cleanup-hook"],
    description: "Override the workspace cleanup hook.",
    flagDescriptions: {
      "--no-cleanup-hook": "Disable the workspace cleanup hook.",
    },
    exposure: "cli",
    completion: { kind: "file" },
  },
);

const optionalWorktreeSchema = z.union([z.string().min(1), z.boolean()]).optional();
const optionalHookSchema = z.union([z.string(), z.literal(false)]).optional();

export const runSchema = z
  .object({
    backend: agentBackendSchema,
    name: z.string().min(1).optional(),
    workspace: z.string().trim().min(1).optional(),
    worktree: optionalWorktreeSchema,
    worktreeRoot: z.string().optional(),
    setupHook: optionalHookSchema,
    cleanupHook: optionalHookSchema,
    backendArgs: z.array(z.string()).default([]),
  })
  .transform((input) => {
    const worktreeName = typeof input.worktree === "string" ? input.worktree : undefined;
    return {
      backend: input.backend,
      name: input.name ?? worktreeName,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
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
  const command = parent.command("run [backend] [backendArgs...]").description("Run an agent backend");
  registerOptions(command, runOptionSpecs, context.buildMode);
  command.allowUnknownOption(true);

  command.action(async (backend, backendArgs, options) => {
    const resolved = resolveCommandOptions(options, runOptionSpecs, context);
    const capabilities = context.resolveAgentCapabilities ? await context.resolveAgentCapabilities() : undefined;
    const selectedBackend = backend ?? capabilities?.default;
    if (selectedBackend !== undefined && capabilities && !capabilities.enabled.includes(selectedBackend)) {
      throw new Error(
        `agent backend is disabled: ${selectedBackend}; enable it with "muximo config set agents.enabled"`,
      );
    }
    context.report(
      await invokeCliHandler({
        schema: runSchema,
        rawInput: { ...resolved, backend: selectedBackend, backendArgs },
        commandPath: ["run"],
        context,
        handler: handlers.run,
      }),
    );
  });
  return command;
}
