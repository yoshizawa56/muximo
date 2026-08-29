import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../../options/index.js";
import type { CliCommandContext, CliHandlers, CliWorkspaceAddInput, CliWorkspaceUpdateInput } from "../types.js";
import { invokeCliHandler, resolveCommandOptions } from "../validation.js";
import { firstBooleanOrString, firstString } from "./common.js";

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
);

const mutationFields = {
  name: z.string().optional(),
  nameExplicit: z.boolean().default(false),
  setupHook: z.union([z.string(), z.null()]).optional(),
  setupHookExplicit: z.boolean().default(false),
  cleanupHook: z.union([z.string(), z.null()]).optional(),
  cleanupHookExplicit: z.boolean().default(false),
};

export const workspaceAddSchema = z.object({
  directory: z.string().trim().min(1, { error: "workspace add requires a directory" }),
  ...mutationFields,
});

export const workspaceUpdateSchema = z.object({
  selector: z.string().trim().min(1, { error: "workspace update requires a workspace selector" }),
  ...mutationFields,
});

export function registerWorkspaceAddCommand(
  parent: Command,
  handlers: CliHandlers,
  context: CliCommandContext,
): Command {
  const command = configureMutationCommand(parent.command("add [directory]").alias("create"));
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
  name?: string;
  nameExplicit: boolean;
  setupHook?: string | null;
  setupHookExplicit: boolean;
  cleanupHook?: string | null;
  cleanupHookExplicit: boolean;
} {
  const setupHook = firstBooleanOrString(options, ["setupHook"], []);
  const cleanupHook = firstBooleanOrString(options, ["cleanupHook"], []);
  return {
    name: firstString(options, ["name"]),
    nameExplicit: options.name !== undefined,
    setupHook: setupHook.value,
    setupHookExplicit: setupHook.explicit,
    cleanupHook: cleanupHook.value,
    cleanupHookExplicit: cleanupHook.explicit,
  };
}

export type { CliWorkspaceAddInput, CliWorkspaceUpdateInput };
