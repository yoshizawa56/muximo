import type { Command } from "commander";
import { z } from "zod";
import { registerOptions } from "../options/index.js";
import { globalOptionSpecs } from "./global.js";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler, resolveCommandOptions } from "./validation.js";

export const doctorSchema = z.object({
  verbose: z.boolean().default(false),
});

export function registerDoctorCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("doctor").description("Inspect local muximo state");
  registerOptions(command, globalOptionSpecs, context.buildMode);
  command.action(async (options) => {
    const resolved = resolveCommandOptions(options, globalOptionSpecs, context);
    context.report(
      await invokeCliHandler({
        schema: doctorSchema,
        rawInput: resolved,
        commandPath: ["doctor"],
        context,
        handler: handlers.doctor,
      }),
    );
  });
  return command;
}
