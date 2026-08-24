import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

export const pairSchema = z
  .object({
    withoutServe: z.boolean().default(false),
    muximodBaseUrl: z.string().url().optional(),
    controlSocket: z.string().min(1).optional(),
    open: z.boolean().default(false),
    terminal: z.boolean().default(false),
  })
  .superRefine((input, context) => {
    if (input.open && input.terminal) {
      context.addIssue({ code: "custom", path: ["terminal"], message: "--open and --terminal cannot be combined" });
    }
  })
  .transform(({ open, terminal, ...input }) => ({
    ...input,
    display: terminal ? "terminal" : "browser",
  }));

export function registerPairCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent
    .command("pair")
    .description("Pair a device with muximod")
    .option("--without-serve")
    .option("--muximod-base-url <url>")
    .option("--control-socket <path>")
    .option("--open")
    .option("--terminal");
  command.action(async (options) => {
    context.report(
      await invokeCliHandler({
        schema: pairSchema,
        rawInput: options,
        commandPath: ["pair"],
        context,
        handler: handlers.pair,
      }),
    );
  });
  return command;
}
