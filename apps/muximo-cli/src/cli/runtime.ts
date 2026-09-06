import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveInstancePaths } from "@muximo/instance-contract";
import { z } from "zod";
import type { CliBuildMode } from "./build-mode.js";
import { globalOptionSpecs } from "./commands/global.js";
import { type CliOptionResolution, getAvailableOptionSpecs, resolveOptionValues } from "./options/index.js";
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

const cliRuntimeSchema = z.object({
  instanceDirectory: z.string().min(1),
  verbose: z.boolean().default(false),
});

export type ResolveMuximoCliRuntimeOptions = {
  raw: Record<string, unknown>;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  buildMode?: CliBuildMode;
};

export type MuximoCliRuntimeResolution = {
  values: CliOptionResolution["values"];
  environment: NodeJS.ProcessEnv;
  runtime: MuximoCliRuntimeOptions;
};

export function resolveMuximoCliRuntimeOptions(input: ResolveMuximoCliRuntimeOptions): MuximoCliRuntimeResolution {
  const buildMode = input.buildMode ?? "development";
  const optionSpecs = getAvailableOptionSpecs(globalOptionSpecs, buildMode);
  const homeDirectory = input.environment.HOME ?? homedir();
  const resolution = resolveOptionValues(input.raw, optionSpecs, {
    args: input.args,
    environment: input.environment,
    buildMode,
  });
  const runtimeValues = { ...resolution.values };
  const parsed = parseRuntimeValues(runtimeValues);

  const instanceDirectory = resolveConfiguredPath(parsed.instanceDirectory, input.cwd, homeDirectory);
  const paths = resolveInstancePaths(instanceDirectory);
  const runtime: MuximoCliRuntimeOptions = {
    ...paths,
    verbose: parsed.verbose,
  };
  return {
    values: runtimeValues,
    environment: applyRuntimeEnvironment(input.environment, runtime),
    runtime,
  };
}

function parseRuntimeValues(values: CliOptionResolution["values"]): z.infer<typeof cliRuntimeSchema> {
  const parsed = cliRuntimeSchema.safeParse(values);
  if (!parsed.success) throw new Error(`Invalid CLI runtime options:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

function applyRuntimeEnvironment(environment: NodeJS.ProcessEnv, runtime: MuximoCliRuntimeOptions): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = {
    ...environment,
    MUXIMOD_INSTANCE_DIR: runtime.instanceDirectory,
  };
  for (const key of [
    "MUXIMO_ENV",
    "MUXIMO_STATE_ROOT",
    "MUXIMO_MUXIMOD_HOST",
    "MUXIMO_MUXIMOD_PORT",
    "MUXIMO_MUXIMOD_SERVE_PORT",
    "MUXIMO_SCHEMA_MODE",
    "MUXIMO_LOG_LEVEL",
    "MUXIMO_LOG_FILE",
    "MUXIMOD_ALLOWED_ORIGINS",
    "MUXIMOD_WORKSPACE_ROOTS",
    "MUXIMO_CODEX_REMOTE",
    "MUXIMO_TAILSCALE_ARGS",
    "MUXIMO_TAILSCALE_HOSTNAME",
    "MUXIMO_TAILSCALE_PATH",
    "TAILSCALE_BIN",
    "MUXIMO_CODEX_BIN",
    "MUXIMO_CLAUDE_BIN",
    "MUXIMO_OPENCODE_BIN",
    "MUXIMO_OPENCODE_SERVER_URL",
    "MUXIMO_OPENCODE_REGISTRY_FILE",
  ]) {
    delete resolved[key];
  }
  return resolved;
}

function resolveConfiguredPath(value: string, cwd: string, homeDirectory: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}
