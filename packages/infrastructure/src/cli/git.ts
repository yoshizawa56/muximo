import { execFileSync, spawnSync } from "node:child_process";
import { realpathSafe } from "./filesystem.js";

export const gitOutputMaxBuffer = 64 * 1024 * 1024;

export function gitWorkspaceRoot(cwd: string): string | undefined {
  try {
    return realpathSafe(
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        maxBuffer: gitOutputMaxBuffer,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

export function gitRequired(cwd: string, args: string[], message: string, environment?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: gitOutputMaxBuffer,
    }).trim();
  } catch {
    throw new Error(message);
  }
}

export function gitOutputRaw(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: gitOutputMaxBuffer,
  });
}

/** Runs an optional probe whose absence is represented by an empty result. */
export function gitOutputOrEmpty(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  try {
    return gitOutputRaw(cwd, args, environment).trim();
  } catch {
    return "";
  }
}

export function gitStatusCode(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): number {
  return spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore", env: environment }).status ?? 1;
}

export function listUnmanagedFiles(cwd: string, environment?: NodeJS.ProcessEnv): string[] {
  const files = new Set<string>();
  for (const args of [
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ]) {
    for (const file of gitOutputRaw(cwd, args, environment).split("\u0000")) {
      if (file) files.add(file);
    }
  }
  return [...files];
}

export function listIgnoredFiles(
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  pathspecs?: readonly string[],
): string[] {
  if (pathspecs?.length === 0) return [];
  const args = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
  if (pathspecs) args.push("--", ...pathspecs);
  return gitOutputRaw(cwd, args, environment).split("\u0000").filter(Boolean);
}

export function listIgnoredDirectories(
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  candidateDirectories?: readonly string[],
): string[] {
  const candidates = candidateDirectories
    ? candidateDirectories.map((directory) => (directory.endsWith("/") ? directory : `${directory}/`))
    : gitOutputRaw(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], environment)
        .split("\u0000")
        .filter((path) => path.endsWith("/"));
  return ignoredPaths(cwd, candidates, environment).map((path) => path.slice(0, -1));
}

function ignoredPaths(cwd: string, paths: readonly string[], environment?: NodeJS.ProcessEnv): string[] {
  if (paths.length === 0) return [];
  const result = spawnSync("git", ["-C", cwd, "check-ignore", "--no-index", "--stdin", "-z"], {
    input: `${paths.join("\u0000")}\u0000`,
    encoding: "utf8",
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
    maxBuffer: gitOutputMaxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed with status ${result.status ?? "unknown"}`);
  }
  return (result.stdout ?? "").split("\u0000").filter(Boolean);
}

export function gitStatus(cwd: string, environment?: NodeJS.ProcessEnv): string {
  return gitOutputRaw(cwd, ["status", "--porcelain", "--untracked-files=normal"], environment);
}
