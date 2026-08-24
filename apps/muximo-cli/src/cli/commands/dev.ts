import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

const devSchema = z.object({ serveProvider: z.literal("tailscale").optional() });

export function registerDevCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const dev = parent.command("dev").description("Run the local development supervisor");
  dev.action(async () => {
    context.report(
      await invokeCliHandler({
        schema: devSchema,
        rawInput: {},
        commandPath: ["dev"],
        context,
        handler: handlers.dev,
      }),
    );
  });
  const serve = dev.command("serve").description("Run the development supervisor with an exposure provider");
  serve.command("tailscale").action(async () => {
    context.report(
      await invokeCliHandler({
        schema: devSchema,
        rawInput: { serveProvider: "tailscale" },
        commandPath: ["dev", "serve", "tailscale"],
        context,
        handler: handlers.dev,
      }),
    );
  });
  return dev;
}
