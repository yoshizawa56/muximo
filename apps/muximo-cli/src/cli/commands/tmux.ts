import { resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

export const tmuxNewSessionOptionSpecs = defineOptions(
  {
    key: "name",
    flags: ["-s, --name <name>"],
    description: "Name of the tmux session.",
    exposure: "cli",
  },
  {
    key: "cwd",
    flags: ["-c, --cwd <path>"],
    description: "Working directory for the tmux session.",
    exposure: "cli",
    completion: { kind: "directory" },
  },
  {
    key: "detached",
    flags: ["-d, --detached"],
    description: "Create the tmux session without attaching to it.",
    exposure: "cli",
    defaultValue: false,
  },
);

export const tmuxNewSessionSchema = z.object({
  name: z.string().trim().min(1, { error: "tmux session name is required" }),
  cwd: z.string().trim().min(1, { error: "tmux session cwd is required" }),
  detached: z.boolean().default(false),
});

export const tmuxManageSessionOptionSpecs = defineOptions({
  key: "name",
  flags: ["-s, --name <name>"],
  description: "Name of the existing tmux session.",
  exposure: "cli",
});

export const tmuxManageSessionSchema = z.object({
  name: z.string().trim().min(1, { error: "tmux session name is required" }),
});

export function registerTmuxCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("tmux").description("Manage muximo tmux sessions");
  command.action(() => {
    context.report(2);
  });

  const newSession = command.command("new-session").description("Create a managed tmux session");
  registerOptions(newSession, tmuxNewSessionOptionSpecs);
  newSession.action(async (options) => {
    const resolved = resolveCommandOptions(options, tmuxNewSessionOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: tmuxNewSessionSchema,
        rawInput: {
          ...resolved,
          name: resolved.name ?? "muximod",
          cwd: resolve(context.cwd, typeof resolved.cwd === "string" ? resolved.cwd : context.cwd),
        },
        commandPath: ["tmux", "new-session"],
        context,
        handler: handlers.tmuxNewSession,
      }),
    );
  });

  const manageSession = command.command("manage-session").description("Adopt an existing tmux session into muximo");
  registerOptions(manageSession, tmuxManageSessionOptionSpecs);
  manageSession.action(async (options) => {
    const resolved = resolveCommandOptions(options, tmuxManageSessionOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: tmuxManageSessionSchema,
        rawInput: { ...resolved, name: resolved.name ?? "" },
        commandPath: ["tmux", "manage-session"],
        context,
        handler: handlers.tmuxManageSession,
      }),
    );
  });
  return command;
}
