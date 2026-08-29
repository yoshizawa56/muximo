import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { normalizeAllowedOrigins } from "@muximo/infrastructure/cli-client";
import { isLoopbackOrPrivateBindHost } from "@muximo/profile";
import { z } from "zod";
import { globalOptionSpecs } from "./commands/global.js";
import { type CliOptionResolution, resolveOptionValues } from "./options/index.js";
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

const cliRuntimeSchema = z.object({
  environment: z.string().min(1),
  stateRoot: z.string().min(1),
  muximodHost: z.string().min(1),
  muximodPort: z.coerce.number().int().min(1).max(65_535),
  muximodServePort: z.coerce.number().int().min(1).max(65_535),
  schemaMode: z.enum(["migrate", "push"]),
  logLevel: z.enum(["error", "warn", "info", "debug"]),
  logFile: z.string().min(1).optional(),
  allowedOrigins: z.array(z.string()).default([]),
  codexRemote: z.string().min(1),
  verbose: z.boolean().default(false),
});

export type ResolveMuximoCliRuntimeOptions = {
  raw: Record<string, unknown>;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
};

export type MuximoCliRuntimeResolution = {
  values: CliOptionResolution["values"];
  environment: NodeJS.ProcessEnv;
  runtime: MuximoCliRuntimeOptions;
};

export function resolveMuximoCliRuntimeOptions(input: ResolveMuximoCliRuntimeOptions): MuximoCliRuntimeResolution {
  const resolution = resolveOptionValues(input.raw, globalOptionSpecs, {
    args: input.args,
    environment: input.environment,
  });
  const parsed = cliRuntimeSchema.safeParse(resolution.values);
  if (!parsed.success) {
    throw new Error(`Invalid CLI runtime options:\n${z.prettifyError(parsed.error)}`);
  }

  const homeDirectory = input.environment.HOME ?? homedir();
  const stateRoot = resolveConfiguredPath(parsed.data.stateRoot, input.cwd, homeDirectory);
  const muximodInstanceDirectory = join(stateRoot, parsed.data.environment, "muximod");
  const muximodHost = readBindHost(parsed.data.muximodHost);
  const logFile = resolveConfiguredPath(
    parsed.data.logFile ?? join(muximodInstanceDirectory, "muximod.log"),
    input.cwd,
    homeDirectory,
  );
  const allowedOrigins = normalizeAllowedOrigins(parsed.data.allowedOrigins);
  const runtime: MuximoCliRuntimeOptions = {
    environmentName: parsed.data.environment,
    stateRoot,
    muximodInstanceDirectory,
    muximodHost,
    muximodPort: parsed.data.muximodPort,
    muximodServePort: parsed.data.muximodServePort,
    schemaMode: parsed.data.schemaMode,
    logLevel: parsed.data.logLevel,
    logFile,
    allowedOrigins,
    codexRemote: parsed.data.codexRemote,
    verbose: parsed.data.verbose,
  };
  return {
    values: resolution.values,
    environment: applyRuntimeEnvironment(input.environment, runtime),
    runtime,
  };
}

function applyRuntimeEnvironment(environment: NodeJS.ProcessEnv, runtime: MuximoCliRuntimeOptions): NodeJS.ProcessEnv {
  const resolved: NodeJS.ProcessEnv = {
    ...environment,
    MUXIMO_ENV: runtime.environmentName,
    MUXIMOD_INSTANCE_DIR: runtime.muximodInstanceDirectory,
    MUXIMOD_HOST: runtime.muximodHost,
    MUXIMOD_PORT: String(runtime.muximodPort),
    MUXIMO_MUXIMOD_SERVE_PORT: String(runtime.muximodServePort),
    MUXIMO_SCHEMA_MODE: runtime.schemaMode,
    MUXIMO_LOG_LEVEL: runtime.logLevel,
    MUXIMO_LOG_FILE: runtime.logFile,
    MUXIMOD_ALLOWED_ORIGINS: runtime.allowedOrigins.join(","),
    MUXIMO_CODEX_REMOTE: runtime.codexRemote,
  };

  delete resolved.MUXIMO_DEV_STATE_ROOT;
  delete resolved.BASE_MUXIMOD_INSTANCE_DIR;
  delete resolved.MUXIMOD_PID_FILE;
  delete resolved.MUXIMOD_CONTROL_SOCKET;
  delete resolved.MUXIMO_HOOK_OUTPUT_DIR;
  delete resolved.MUXIMO_SERVE_PORT;
  return resolved;
}

function readBindHost(value: string): string {
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isLoopbackOrPrivateBindHost(normalized)) return normalized;
  throw new Error(`MUXIMO_MUXIMOD_HOST must be localhost, a loopback address, or a private IP address: ${value}`);
}

function resolveConfiguredPath(value: string, cwd: string, homeDirectory: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}
