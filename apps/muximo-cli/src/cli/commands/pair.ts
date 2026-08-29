import type { Command } from "commander";
import { z } from "zod";
import { defineOptions, registerOptions } from "../options/index.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "URL must use http or https without credentials");

export const pairOptionSpecs = defineOptions(
  {
    key: "withoutServe",
    flags: ["--without-serve"],
    description: "Use an already available muximod URL instead of starting a serving provider.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "muximodBaseUrl",
    flags: ["--muximod-base-url <url>"],
    description: "Base URL used to reach muximod.",
    exposure: "cli",
    completion: { kind: "url" },
  },
  {
    key: "open",
    flags: ["--open"],
    description: "Open the pairing page in a browser.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "terminal",
    flags: ["--terminal"],
    description: "Display the pairing flow in the terminal.",
    exposure: "cli",
    defaultValue: false,
  },
);

export const pairSchema = z
  .object({
    withoutServe: z.boolean().default(false),
    muximodBaseUrl: httpUrlSchema.optional(),
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
  const command = parent.command("pair").description("Pair a device with muximod");
  registerOptions(command, pairOptionSpecs);
  command.action(async (options) => {
    const resolved = resolveCommandOptions(options, pairOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: pairSchema,
        rawInput: resolved,
        commandPath: ["pair"],
        context,
        handler: handlers.pair,
      }),
    );
  });
  return command;
}
