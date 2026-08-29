import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const serveSchema = z.object({
  provider: z.literal("tailscale"),
  command: z.enum(["tailscale", "status", "stop"]),
  localPort: z.number().int().min(1).max(65_535),
  externalPort: z.number().int().min(1).max(65_535),
});

export function registerServeCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const serve = parent.command("serve").description("Manage the muximod external route");
  serve.action(() => context.report(2));
  for (const command of ["tailscale", "status", "stop"] as const) {
    const child = serve.command(command).description(`${command} the muximod Tailscale route`);
    child.action(async () => {
      context.report(
        await invokeCliHandler({
          schema: serveSchema,
          rawInput: {
            provider: "tailscale",
            command,
            localPort: requireRuntime(context).muximodPort,
            externalPort: requireRuntime(context).muximodServePort,
          },
          commandPath: ["serve", command],
          context,
          handler: handlers.serve,
        }),
      );
    });
  }
  return serve;
}

function requireRuntime(context: CliCommandContext) {
  if (!context.runtime) throw new Error("CLI runtime options are unavailable");
  return context.runtime;
}
