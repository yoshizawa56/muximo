import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function realpathAfterMkdir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSafe(path);
}

export function resolveFromRoot(value: string, root: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

export function timestamp(): string {
  return new Date().toISOString();
}

export function localTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function unlinkEmptyDirectory(path: string | null | undefined): void {
  if (!path) return;
  try {
    if (readdirSync(path).length === 0) execFileSync("rmdir", [path], { stdio: "ignore" });
  } catch {
    // A shared root or an already removed directory is expected.
  }
}
