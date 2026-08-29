import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

export const daemonOptionSpecs = defineOptions(
  {
    key: "foreground",
    flags: ["--foreground"],
    description: "Keep muximod attached to the current process.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "refreshServers",
    flags: ["--refresh-servers"],
    description: "Refresh registered serving providers after a restart.",
    exposure: "cli",
    defaultValue: false,
  },
);

const daemonSchema = z.object({
  command: z.enum(["start", "status", "stop", "restart", "ensure"]),
  foreground: z.boolean().default(false),
  refreshServers: z.boolean().default(false),
});

export const daemonLogOptionSpecs = defineOptions({
  key: "lines",
  flags: ["-n, --lines <count>"],
  description: "Number of recent daemon log lines to print.",
  exposure: "cli",
  defaultValue: 100,
  completion: { kind: "integer" },
});

const daemonLogSchema = z.object({
  command: z.literal("log"),
  lines: z.coerce.number().int().min(1).max(10_000).default(100),
  foreground: z.literal(false).default(false),
  refreshServers: z.literal(false).default(false),
});

export function registerDaemonCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const daemon = parent.command("daemon").description("Manage the muximod daemon");
  daemon.action(() => context.report(2));
  for (const command of ["start", "status", "stop", "restart", "ensure"] as const) {
    const child = daemon.command(command).description(`${command} muximod`);
    registerOptions(child, daemonOptionSpecs, context.buildMode);
    child.action(async (options) => {
      const resolved = resolveCommandOptions(options, daemonOptionSpecs, context);
      context.report(
        await invokeCliHandler({
          schema: daemonSchema,
          rawInput: { ...resolved, command },
          commandPath: ["daemon", command],
          context,
          handler: handlers.daemon,
        }),
      );
    });
  }
  const log = daemon.command("log").description("Show recent muximod log lines");
  registerOptions(log, daemonLogOptionSpecs, context.buildMode);
  log.action(async (options) => {
    const resolved = resolveCommandOptions(options, daemonLogOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: daemonLogSchema,
        rawInput: { ...resolved, command: "log", foreground: false, refreshServers: false },
        commandPath: ["daemon", "log"],
        context,
        handler: handlers.daemon,
      }),
    );
  });
  return daemon;
}
