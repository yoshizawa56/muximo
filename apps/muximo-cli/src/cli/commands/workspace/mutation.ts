import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers, CliWorkspaceAddInput, CliWorkspaceUpdateInput } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";
import { firstBooleanOrString, firstString, mergeStringArrays } from "./common.js";

export const workspaceMutationOptionSpecs = defineOptions(
  {
    key: "directory",
    flags: ["--directory <path>"],
    description: "Legacy directory option; use the positional directory argument for add.",
    exposure: "cli",
    completion: { kind: "directory" },
  },
  {
    key: "path",
    flags: ["--path <path>"],
    description: "Legacy path option retained for compatibility.",
    exposure: "cli",
    completion: { kind: "directory" },
  },
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
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "setupScript",
    flags: ["--setup-script <path>", "--no-setup-script"],
    description: "Alias for the workspace setup hook.",
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "setupScriptPath",
    flags: ["--setup-script-path <path>"],
    description: "Alias for the workspace setup hook path.",
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "cleanupHook",
    flags: ["--cleanup-hook <path>", "--no-cleanup-hook"],
    description: "Workspace cleanup hook.",
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "cleanupScript",
    flags: ["--cleanup-script <path>", "--no-cleanup-script"],
    description: "Alias for the workspace cleanup hook.",
    exposure: "cli",
    completion: { kind: "file" },
  },
  {
    key: "cleanupScriptPath",
    flags: ["--cleanup-script-path <path>"],
    description: "Alias for the workspace cleanup hook path.",
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
    key: "worktreeCopyPattern",
    flags: ["--worktree-copy-pattern <pattern>"],
    description: "Alias for a workspace copy pattern.",
    exposure: "cli",
    repeatable: true,
  },
  {
    key: "copy",
    flags: ["--copy <pattern>"],
    description: "Alias for a workspace copy pattern.",
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
    key: "appendCopyPattern",
    flags: ["--append-copy-pattern <pattern>"],
    description: "Alias for an appended workspace copy pattern.",
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
  {
    key: "copyPatterns",
    flags: ["--no-copy-patterns"],
    description: "Clear all workspace copy patterns.",
    exposure: "cli",
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
    directoryOption: z.string().optional(),
    pathOption: z.string().optional(),
    ...mutationFields,
  })
  .superRefine((input, context) => {
    if (input.directoryOption !== undefined || input.pathOption !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["directory"],
        message: "workspace add accepts the directory as a positional argument",
      });
    }
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
  })
  .transform(({ directory, directoryOption: _directoryOption, pathOption: _pathOption, ...input }) => ({
    ...input,
    directory,
  }));

export const workspaceUpdateSchema = z
  .object({
    selector: z.string().trim().min(1, { error: "workspace update requires a workspace selector" }),
    directoryOption: z.string().optional(),
    pathOption: z.string().optional(),
    ...mutationFields,
  })
  .superRefine((input, context) => {
    if (input.directoryOption !== undefined || input.pathOption !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["directoryOption"],
        message: "workspace directory is immutable; delete and add a new registration",
      });
    }
    if (input.copyPatternsExplicit && input.clearCopyPatterns) {
      context.addIssue({
        code: "custom",
        path: ["clearCopyPatterns"],
        message: "--clear-copy-patterns cannot be combined with --copy-pattern",
      });
    }
  })
  .transform(({ selector, directoryOption: _directoryOption, pathOption: _pathOption, ...input }) => ({
    ...input,
    selector,
  }));

export function registerWorkspaceAddCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
  commandName: "add" | "register" = "add",
): Command {
  const command = configureMutationCommand(parent.command(`${commandName} [directory]`));
  command.action(async (directory, options) => {
    const resolved = resolveCommandOptions(options, workspaceMutationOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: workspaceAddSchema,
        rawInput: { directory, ...normalizeMutationOptions(resolved) },
        commandPath: ["workspace", commandName],
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
  const command = configureMutationCommand(parent.command("update [selector]"));
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

function configureMutationCommand(command: Command): Command {
  command.description("Register or update a workspace");
  registerOptions(command, workspaceMutationOptionSpecs);
  return command.allowUnknownOption(false);
}

function normalizeMutationOptions(options: Record<string, unknown>): {
  directoryOption?: string;
  pathOption?: string;
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
  const setupHook = firstBooleanOrString(
    options,
    ["setupHook", "setupScript", "setupScriptPath"],
    ["noSetupHook", "noSetupScript"],
  );
  const cleanupHook = firstBooleanOrString(
    options,
    ["cleanupHook", "cleanupScript", "cleanupScriptPath"],
    ["noCleanupHook", "noCleanupScript"],
  );
  const copyPatterns = mergeStringArrays(options, ["copyPattern", "worktreeCopyPattern", "copy"]);
  const appendCopyPatterns = mergeStringArrays(options, ["addCopyPattern", "appendCopyPattern"]);
  const clearCopyPatterns = options.clearCopyPatterns === true || options.copyPatterns === false;
  return {
    directoryOption: firstString(options, ["directory"]),
    pathOption: firstString(options, ["path"]),
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
