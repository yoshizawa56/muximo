import { execFileSync, spawnSync } from "node:child_process";
import { realpathSafe } from "./filesystem.js";

export function gitWorkspaceRoot(cwd: string): string | undefined {
  try {
    return realpathSafe(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
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
    }).trim();
  } catch {
    throw new Error(message);
  }
}

export function gitOutputRaw(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: environment,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function gitOutputOrEmpty(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): string {
  return gitOutputRaw(cwd, args, environment).trim();
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

export function gitStatus(cwd: string, environment?: NodeJS.ProcessEnv): string {
  return gitOutputRaw(cwd, ["status", "--porcelain", "--untracked-files=all"], environment);
}
