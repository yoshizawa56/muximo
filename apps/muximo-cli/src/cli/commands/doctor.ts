import type { Command } from "commander";
import { z } from "zod";
import type { CliCommandContext, CliHandlers } from "./types.js";
import { invokeCliHandler } from "./validation.js";

export const doctorSchema = z.object({
  verbose: z.boolean().default(false),
});

export function registerDoctorCommand(parent: Command, handlers: CliHandlers, context: CliCommandContext): Command {
  const command = parent.command("doctor").description("Inspect local muximo state").option("--verbose");
  command.action(async (options) => {
    context.report(
      await invokeCliHandler({
        schema: doctorSchema,
        rawInput: options,
        commandPath: ["doctor"],
        context,
        handler: handlers.doctor,
      }),
    );
  });
  return command;
}
