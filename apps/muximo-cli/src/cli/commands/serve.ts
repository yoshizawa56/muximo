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

export const serveOptionSpecs = defineOptions(
  {
    key: "foreground",
    flags: ["--foreground"],
    description: "Keep the serving process attached to the current process.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "port",
    flags: ["--port <port>"],
    description: "External port exposed by the serving provider.",
    exposure: "both",
    environment: { name: "MUXIMO_SERVE_PORT", description: "External port exposed by the serving provider." },
    defaultValue: 8444,
    completion: { kind: "integer" },
  },
  {
    key: "muximodPort",
    flags: ["--muximod-port <port>"],
    description: "Port on which muximod listens locally.",
    exposure: "both",
    environment: { name: "MUXIMOD_PORT", description: "Port on which muximod listens locally." },
    defaultValue: 4317,
    completion: { kind: "integer" },
  },
  {
    key: "muximodHost",
    flags: ["--muximod-host <host>"],
    description: "Host on which muximod listens locally.",
    exposure: "both",
    environment: { name: "MUXIMOD_HOST", description: "Host on which muximod listens locally." },
    defaultValue: "127.0.0.1",
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
    key: "logLevel",
    flags: ["--log-level <level>"],
    description: "Daemon log level used while serving.",
    exposure: "both",
    environment: { name: "MUXIMO_LOG_LEVEL", description: "Daemon log level used while serving." },
    defaultValue: "info",
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
  {
    key: "tailscaleHostname",
    description: "Override the hostname used to derive a Tailscale Serve URL.",
    exposure: "environment",
    environment: {
      name: "MUXIMO_TAILSCALE_HOSTNAME",
      description: "Hostname used to derive a Tailscale Serve URL.",
    },
  },
  {
    key: "tailscaleBinary",
    description: "Override the Tailscale executable used by the serving provider.",
    exposure: "environment",
    environment: { name: "TAILSCALE_BIN", description: "Tailscale executable used by the serving provider." },
  },
);

const serveSchema = z.object({
  provider: z.literal("tailscale"),
  foreground: z.boolean().default(false),
  muximodHost: z.string().min(1).default("127.0.0.1"),
  muximodPort: z.coerce.number().int().min(1).max(65_535).default(4317),
  externalPort: z.coerce.number().int().min(1).max(65_535).default(8444),
  pidFile: z.string().min(1).optional(),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  logFile: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
});

export function registerServeCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const serve = parent.command("serve").description("Expose muximod through a serving provider");
  serve.action(() => context.report(2));
  const tailscale = serve.command("tailscale").description("Expose muximod through Tailscale Serve");
  registerOptions(tailscale, serveOptionSpecs);
  tailscale.action(async (options) => {
    const resolved = resolveCommandOptions(options, serveOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: serveSchema,
        rawInput: {
          provider: "tailscale",
          foreground: resolved.foreground,
          muximodHost: resolved.muximodHost,
          muximodPort: resolved.muximodPort,
          externalPort: resolved.port,
          pidFile: resolved.pidFile,
          logLevel: resolved.logLevel,
          logFile: resolved.logFile,
          allowedOrigins: resolved.allowedOrigin,
        },
        commandPath: ["serve", "tailscale"],
        context,
        handler: handlers.serve,
      }),
    );
  });
  return serve;
}
