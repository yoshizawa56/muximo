import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { MuximoAgentBackend } from "@muximo/instance-contract";

export type ExecutableDiscoveryContext = Readonly<{
  cwd: string;
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}>;

export type ExecutableCandidate = Readonly<{
  value: string;
  source: "configured" | "platform-default" | "path";
}>;

const tailscaleMacExecutable = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export function discoverAgentExecutableCandidates(
  backend: MuximoAgentBackend,
  context: ExecutableDiscoveryContext,
  configuredValue?: string,
): readonly ExecutableCandidate[] {
  const candidates: ExecutableCandidate[] = [];
  if (configuredValue !== undefined && isExecutableReference(configuredValue, context)) {
    candidates.push({ value: configuredValue, source: "configured" });
  }
  const pathValue = findOnPath(backend, context);
  if (pathValue !== undefined) candidates.push({ value: pathValue, source: "path" });
  return uniqueCandidates(candidates);
}

export function discoverTailscaleExecutableCandidates(
  context: ExecutableDiscoveryContext,
  configuredValue?: string,
): readonly ExecutableCandidate[] {
  const candidates: ExecutableCandidate[] = [];
  if (configuredValue !== undefined && isExecutableReference(configuredValue, context)) {
    candidates.push({ value: configuredValue, source: "configured" });
  }
  if (context.platform === "darwin" && isExecutableFile(tailscaleMacExecutable, context.platform)) {
    candidates.push({ value: tailscaleMacExecutable, source: "platform-default" });
  }
  const pathValue = findOnPath("tailscale", context);
  if (pathValue !== undefined) candidates.push({ value: pathValue, source: "path" });
  return uniqueCandidates(candidates);
}

export function recommendedTailscaleExecutable(platform: NodeJS.Platform): string {
  return platform === "darwin" ? tailscaleMacExecutable : "tailscale";
}

export function isExecutableReference(value: string, context: ExecutableDiscoveryContext): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (isPathReference(trimmed)) return isExecutableFile(resolveUserPath(trimmed, context), context.platform);
  return findOnPath(trimmed, context) !== undefined;
}

export function executableValidationMessage(value: string, context: ExecutableDiscoveryContext): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "An executable name or path is required.";
  if (isExecutableReference(trimmed, context)) return undefined;
  return `Executable was not found or is not executable: ${trimmed}`;
}

export function completeExecutablePath(line: string, context: ExecutableDiscoveryContext): readonly string[] {
  const separator = line.lastIndexOf("/");
  if (separator < 0 && !line.startsWith("~") && !line.startsWith(".")) return [];
  const typedDirectory = separator < 0 ? "." : line.slice(0, separator + 1);
  const typedName = separator < 0 ? line : line.slice(separator + 1);
  const directory = resolveUserPath(typedDirectory, context);
  const prefix = separator < 0 ? "" : line.slice(0, separator + 1);
  try {
    const entries = readdirSync(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name.startsWith(typedName))
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

function findOnPath(command: string, context: ExecutableDiscoveryContext): string | undefined {
  const pathValue = context.environment.PATH ?? "";
  for (const directory of pathValue.split(delimiter)) {
    const baseDirectory = directory.length === 0 ? context.cwd : directory;
    for (const candidate of executableCandidates(join(baseDirectory, command), context.platform, context.environment)) {
      if (isExecutableFile(candidate, context.platform)) return candidate;
    }
  }
  return undefined;
}

function executableCandidates(
  value: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  if (platform !== "win32") return [value];
  const extensions = (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";");
  return [value, ...extensions.map((extension) => `${value}${extension.toLowerCase()}`)];
}

function isExecutableFile(value: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(value).isFile()) return false;
    if (platform === "win32") return true;
    accessSync(value, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathReference(value: string): boolean {
  return (
    value === "~" ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("/") ||
    value.includes("\\") ||
    isAbsolute(value)
  );
}

function resolveUserPath(value: string, context: ExecutableDiscoveryContext): string {
  const home = context.environment.HOME ?? context.environment.USERPROFILE ?? context.cwd;
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(context.cwd, value);
}

function uniqueCandidates(candidates: readonly ExecutableCandidate[]): readonly ExecutableCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}
