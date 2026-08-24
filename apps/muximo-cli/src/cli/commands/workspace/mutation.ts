import type { Command, OptionValues } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers, CliWorkspaceAddInput, CliWorkspaceUpdateInput } from "../types.js";
import { invokeCliHandler } from "../validation.js";
import { collectOption, firstBooleanOrString, firstString, mergeStringArrays } from "./common.js";

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
    context.report(
      await invokeCliHandler({
        schema: workspaceAddSchema,
        rawInput: { directory, ...normalizeMutationOptions(options) },
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
    context.report(
      await invokeCliHandler({
        schema: workspaceUpdateSchema,
        rawInput: { selector, ...normalizeMutationOptions(options) },
        commandPath: ["workspace", "update"],
        context,
        handler: handlers.workspaceUpdate,
      }),
    );
  });
  return command;
}

function configureMutationCommand(command: Command): Command {
  return command
    .description("Register or update a workspace")
    .option("--directory <path>")
    .option("--path <path>")
    .option("--name <name>")
    .option("--setup-hook <path>")
    .option("--setup-script <path>")
    .option("--setup-script-path <path>")
    .option("--no-setup-hook")
    .option("--no-setup-script")
    .option("--cleanup-hook <path>")
    .option("--cleanup-script <path>")
    .option("--cleanup-script-path <path>")
    .option("--no-cleanup-hook")
    .option("--no-cleanup-script")
    .option("--copy-pattern <pattern>", "", collectOption, [])
    .option("--worktree-copy-pattern <pattern>", "", collectOption, [])
    .option("--copy <pattern>", "", collectOption, [])
    .option("--add-copy-pattern <pattern>", "", collectOption, [])
    .option("--append-copy-pattern <pattern>", "", collectOption, [])
    .option("--clear-copy-patterns")
    .option("--no-copy-patterns")
    .allowUnknownOption(false);
}

function normalizeMutationOptions(options: OptionValues): {
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
