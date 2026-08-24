import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const serveSchema = z.object({
  provider: z.literal("tailscale"),
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
  const tailscale = serve
    .command("tailscale")
    .description("Expose muximod through Tailscale Serve")
    .option("--port <port>")
    .option("--muximod-port <port>")
    .option("--muximod-host <host>")
    .option("--pid-file <path>")
    .option("--log-level <level>")
    .option("--log-file <path>")
    .option("--allowed-origin <origin...>");
  tailscale.action(async (options) => {
    context.report(
      await invokeCliHandler({
        schema: serveSchema,
        rawInput: {
          provider: "tailscale",
          muximodHost: options.muximodHost,
          muximodPort: options.muximodPort,
          externalPort: options.port,
          pidFile: options.pidFile,
          logLevel: options.logLevel,
          logFile: options.logFile,
          allowedOrigins: options.allowedOrigin,
        },
        commandPath: ["serve", "tailscale"],
        context,
        handler: handlers.serve,
      }),
    );
  });
  return serve;
}
