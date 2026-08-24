import { z } from "zod";
import { resolveCliOptions, type CliOptionSpec } from "../options/index.js";
import type { CliCommandContext } from "./types.js";

export type CliSchema<TOutput> = z.ZodType<TOutput>;

export function resolveCommandOptions(
  raw: Record<string, unknown>,
  specs: readonly CliOptionSpec[],
  context: Pick<CliCommandContext, "args" | "environment">,
): Record<string, unknown> {
  return resolveCliOptions(raw, specs, context);
}

export async function invokeCliHandler<TSchema extends z.ZodType>(input: {
  schema: TSchema;
  rawInput: unknown;
  commandPath: readonly string[];
  context: CliCommandContext;
  handler(value: z.output<TSchema>): Promise<number>;
}): Promise<number> {
  const parsed = input.schema.safeParse(input.rawInput);
  if (!parsed.success) {
    return reportValidationError(input.context, input.commandPath, parsed.error);
  }
  input.context.lifecycle?.started(input.commandPath);
  let status = 1;
  try {
    status = await input.handler(parsed.data);
    return status;
  } finally {
    input.context.lifecycle?.finished(input.commandPath, status);
  }
}

export function reportValidationError(
  context: Pick<CliCommandContext, "io" | "rootCommand">,
  commandPath: readonly string[],
  error: z.ZodError,
): number {
  const commandName = [context.rootCommand, ...commandPath].join(" ");
  context.io.err.write(`Invalid arguments for ${commandName}\n\n`);
  context.io.err.write(`${z.prettifyError(error)}\n\n`);
  context.io.err.write(`Run "${commandName} --help" for usage.\n`);
  return 2;
}

export function reportCommanderError(
  context: Pick<CliCommandContext, "io" | "rootCommand">,
  commandPath: readonly string[],
  message: string,
): number {
  const error = new z.ZodError([{ code: "custom", path: [], message: normalizeCommanderMessage(message) }]);
  return reportValidationError(context, commandPath, error);
}

function normalizeCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/u, "").trim();
}
