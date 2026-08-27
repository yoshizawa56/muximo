import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLogFile } from "../logging/index.js";

export type DaemonLogResult = {
  state: "available" | "empty" | "missing";
  logFile: string;
  lines: readonly string[];
};

export function readDaemonLog(logFile: string | undefined, lineCount = 100): DaemonLogResult {
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
    throw new Error("daemon log line count must be between 1 and 10000");
  }

  const path = resolve(logFile ?? defaultLogFile());
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return { state: "missing", logFile: path, lines: [] };
    throw new Error(`muximod log file could not be read: ${path}`, { cause: error });
  }

  const lines = contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-lineCount);
  return {
    state: lines.length === 0 ? "empty" : "available",
    logFile: path,
    lines,
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
