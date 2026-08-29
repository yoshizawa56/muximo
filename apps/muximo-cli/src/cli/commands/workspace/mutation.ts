import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers, CliWorkspaceAddInput, CliWorkspaceUpdateInput } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";
import { firstBooleanOrString, firstString, mergeStringArrays } from "./common.js";

export const workspaceMutationOptionSpecs = defineOptions(
  {
    key: "name",
    flags: ["--name <name>"],
    description: "Workspace name.",
    exposure: "cli",
  },
  {
    key: "setupHook",
    flags: ["--setup-hook <path>", "--no-setup-hook"],
    description: "Workspace setup hook.",
    flagDescriptions: {
      "--no-setup-hook": "Disable the workspace setup hook.",
    },
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "cleanupHook",
    flags: ["--cleanup-hook <path>", "--no-cleanup-hook"],
    description: "Workspace cleanup hook.",
    flagDescriptions: {
      "--no-cleanup-hook": "Disable the workspace cleanup hook.",
    },
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "copyPattern",
    flags: ["--copy-pattern <pattern>"],
    description: "Replace workspace copy patterns.",
    exposure: "cli",
    repeatable: true,
  },
  {
    key: "addCopyPattern",
    flags: ["--add-copy-pattern <pattern>"],
    description: "Append a workspace copy pattern.",
    exposure: "cli",
    repeatable: true,
  },
  {
    key: "clearCopyPatterns",
    flags: ["--clear-copy-patterns"],
    description: "Clear all workspace copy patterns.",
    exposure: "cli",
    defaultValue: false,
  },
);

const mutationFields = {
  name: z.string().optional(),
  nameExplicit: z.boolean().default(false),
  setupHook: z.union([z.string(), z.null()]).optional(),
  setupHookExplicit: z.boolean().default(false),
  cleanupHook: z.union([z.string(), z.null()]).optional(),
  cleanupHookExplicit: z.boolean().default(false),
  copyPatterns: z.array(z.string()).default([]),
  copyPatternsExplicit: z.boolean().default(false),
  appendCopyPatterns: z.array(z.string()).default([]),
  clearCopyPatterns: z.boolean().default(false),
};

export const workspaceAddSchema = z
  .object({
    directory: z.string().trim().min(1, { error: "workspace add requires a directory" }),
    ...mutationFields,
  })
  .superRefine((input, context) => {
    if (input.appendCopyPatterns.length > 0 || input.clearCopyPatterns) {
      context.addIssue({
        code: "custom",
        path: ["appendCopyPatterns"],
        message: "--add-copy-pattern and --clear-copy-patterns are only valid for workspace update",
      });
    }
    if (input.copyPatternsExplicit && input.clearCopyPatterns) {
      context.addIssue({
        code: "custom",
        path: ["clearCopyPatterns"],
        message: "--clear-copy-patterns cannot be combined with --copy-pattern",
      });
    }
  });

export const workspaceUpdateSchema = z
  .object({
    selector: z.string().trim().min(1, { error: "workspace update requires a workspace selector" }),
    ...mutationFields,
  })
  .superRefine((input, context) => {
    if (input.copyPatternsExplicit && input.clearCopyPatterns) {
      context.addIssue({
        code: "custom",
        path: ["clearCopyPatterns"],
        message: "--clear-copy-patterns cannot be combined with --copy-pattern",
      });
    }
  });

export function registerWorkspaceAddCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = configureMutationCommand(parent.command("add [directory]"), context);
  command.action(async (directory, options) => {
    const resolved = resolveCommandOptions(options, workspaceMutationOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: workspaceAddSchema,
        rawInput: { directory, ...normalizeMutationOptions(resolved) },
        commandPath: ["workspace", "add"],
        context,
        handler: handlers.workspaceAdd,
      }),
    );
  });
  return command;
}

export function registerWorkspaceUpdateCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = configureMutationCommand(parent.command("update [selector]"), context);
  command.action(async (selector, options) => {
    const resolved = resolveCommandOptions(options, workspaceMutationOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: workspaceUpdateSchema,
        rawInput: { selector, ...normalizeMutationOptions(resolved) },
        commandPath: ["workspace", "update"],
        context,
        handler: handlers.workspaceUpdate,
      }),
    );
  });
  return command;
}

function configureMutationCommand(command: Command, context: CliCommandContext): Command {
  command.description("Register or update a workspace");
  registerOptions(command, workspaceMutationOptionSpecs, context.buildMode);
  return command.allowUnknownOption(false);
}

function normalizeMutationOptions(options: Record<string, unknown>): {
  name?: string;
  nameExplicit: boolean;
  setupHook?: string | null;
  setupHookExplicit: boolean;
  cleanupHook?: string | null;
  cleanupHookExplicit: boolean;
  copyPatterns: string[];
  copyPatternsExplicit: boolean;
  appendCopyPatterns: string[];
  clearCopyPatterns: boolean;
} {
  const setupHook = firstBooleanOrString(options, ["setupHook"], []);
  const cleanupHook = firstBooleanOrString(options, ["cleanupHook"], []);
  const copyPatterns = mergeStringArrays(options, ["copyPattern"]);
  const appendCopyPatterns = mergeStringArrays(options, ["addCopyPattern"]);
  const clearCopyPatterns = options.clearCopyPatterns === true;
  return {
    name: firstString(options, ["name"]),
    nameExplicit: options.name !== undefined,
    setupHook: setupHook.value,
    setupHookExplicit: setupHook.explicit,
    cleanupHook: cleanupHook.value,
    cleanupHookExplicit: cleanupHook.explicit,
    copyPatterns,
    copyPatternsExplicit: copyPatterns.length > 0,
    appendCopyPatterns,
    clearCopyPatterns,
  };
}

export type { CliWorkspaceAddInput, CliWorkspaceUpdateInput };
