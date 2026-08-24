import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const daemonOptions = {
  host: z.string().min(1).default("127.0.0.1"),
  port: z.coerce.number().int().min(1).max(65_535).default(4317),
  pidFile: z.string().min(1).optional(),
  controlSocket: z.string().min(1).optional(),
  muximodBaseUrl: z.string().url().optional(),
  logLevel: z.enum(["error", "warn", "info", "debug"]).optional(),
  logFile: z.string().min(1).optional(),
};

const daemonSchema = z.object({
  command: z.enum(["start", "status", "stop", "restart", "ensure"]),
  foreground: z.boolean().default(false),
  refreshServers: z.boolean().default(false),
  ...daemonOptions,
  allowedOrigins: z.array(z.string().url()).optional(),
});

export function registerDaemonCommands(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const daemon = parent.command("daemon").description("Manage the muximod daemon");
  daemon.action(() => context.report(2));
  for (const command of ["start", "status", "stop", "restart", "ensure"] as const) {
    const child = daemon.command(command).description(`${command} muximod`);
    child
      .option("--foreground")
      .option("--refresh-servers")
      .option("--host <host>")
      .option("--port <port>")
      .option("--pid-file <path>")
      .option("--control-socket <path>")
      .option("--muximod-base-url <url>")
      .option("--log-level <level>")
      .option("--log-file <path>")
      .option("--allowed-origin <origin...>");
    child.action(async (options) => {
      context.report(
        await invokeCliHandler({
          schema: daemonSchema,
          rawInput: { ...options, command, allowedOrigins: options.allowedOrigin },
          commandPath: ["daemon", command],
          context,
          handler: handlers.daemon,
        }),
      );
    });
  }
  return daemon;
}
