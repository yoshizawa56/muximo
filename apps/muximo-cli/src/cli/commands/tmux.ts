import { resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

export const tmuxNewSessionSchema = z.object({
  name: z.string().trim().min(1, { error: "tmux session name is required" }),
  cwd: z.string().trim().min(1, { error: "tmux session cwd is required" }),
  detached: z.boolean().default(false),
});

export function registerTmuxCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("tmux").description("Manage muximo tmux sessions");
  command.action(() => {
    context.report(2);
  });

  const newSession = command
    .command("new-session")
    .description("Create a managed tmux session")
    .option("-s, --name <name>")
    .option("-c, --cwd <path>")
    .option("-d, --detached");
  newSession.action(async (options) => {
    context.report(
      await invokeCliHandler({
        schema: tmuxNewSessionSchema,
        rawInput: {
          ...options,
          name: options.name ?? "muximod",
          cwd: resolve(context.cwd, options.cwd ?? context.cwd),
        },
        commandPath: ["tmux", "new-session"],
        context,
        handler: handlers.tmuxNewSession,
      }),
    );
  });
  return command;
}
