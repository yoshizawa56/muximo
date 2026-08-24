import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

const csvEnvironmentValue = (value: string): string[] =>
  value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

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
    description: "Refresh registered serving providers before the command.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "host",
    flags: ["--host <host>"],
    description: "Host on which muximod listens.",
    exposure: "both",
    environment: { name: "MUXIMOD_HOST", description: "Host on which muximod listens." },
    defaultValue: "127.0.0.1",
  },
  {
    key: "port",
    flags: ["--port <port>"],
    description: "Port on which muximod listens.",
    exposure: "both",
    environment: { name: "MUXIMOD_PORT", description: "Port on which muximod listens." },
    defaultValue: 4317,
    completion: { kind: "integer" },
  },
  {
    key: "pidFile",
    flags: ["--pid-file <path>"],
    description: "Path to the daemon PID file.",
    exposure: "both",
    environment: { name: "MUXIMOD_PID_FILE", description: "Path to the daemon PID file." },
    completion: { kind: "file" },
  },
  {
    key: "controlSocket",
    flags: ["--control-socket <path>"],
    description: "Path to the daemon control socket.",
    exposure: "both",
    environment: { name: "MUXIMOD_CONTROL_SOCKET", description: "Path to the daemon control socket." },
    completion: { kind: "file" },
  },
  {
    key: "muximodBaseUrl",
    flags: ["--muximod-base-url <url>"],
    description: "Base URL used when pairing through the daemon.",
    exposure: "both",
    environment: {
      name: "MUXIMOD_PAIRING_BASE_URL",
      description: "Base URL used when pairing through the daemon.",
    },
    completion: { kind: "url" },
  },
  {
    key: "logLevel",
    flags: ["--log-level <level>"],
    description: "Daemon log level.",
    exposure: "both",
    environment: { name: "MUXIMO_LOG_LEVEL", description: "Daemon log level." },
    completion: { kind: "choices", values: ["error", "warn", "info", "debug"] },
  },
  {
    key: "logFile",
    flags: ["--log-file <path>"],
    description: "Path to the daemon log file.",
    exposure: "both",
    environment: { name: "MUXIMO_LOG_FILE", description: "Path to the daemon log file." },
    completion: { kind: "file" },
  },
  {
    key: "allowedOrigin",
    flags: ["--allowed-origin <origin...>"],
    description: "Allow a browser origin when serving the web UI.",
    exposure: "both",
    environment: {
      name: "MUXIMOD_ALLOWED_ORIGINS",
      description: "Comma-separated browser origins allowed to access the web UI.",
      decode: csvEnvironmentValue,
    },
    completion: { kind: "url" },
  },
);

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
    registerOptions(child, daemonOptionSpecs);
    child.action(async (options) => {
      const resolved = resolveCommandOptions(options, daemonOptionSpecs, context);
      context.report(
        await invokeCliHandler({
          schema: daemonSchema,
          rawInput: { ...resolved, command, allowedOrigins: resolved.allowedOrigin },
          commandPath: ["daemon", command],
          context,
          handler: handlers.daemon,
        }),
      );
    });
  }
  return daemon;
}
