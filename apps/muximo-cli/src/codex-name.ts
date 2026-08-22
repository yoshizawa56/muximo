#!/usr/bin/env bun
import { manageCodexThread } from "./cli/host/codex-remote.js";

const args = process.argv.slice(2);
const usage = "Usage: muximo-codex-name --thread-id ID (--name NAME|--archive|--unarchive) [--socket PATH] [--transport auto|http|raw]\n";
let threadId: string | undefined;
let name: string | undefined;
let socketPath: string | undefined;
let transport: "auto" | "http" | "raw" = "auto";
let operation: "name" | "archive" | "unarchive" | undefined;

try {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--thread-id") threadId = requireValue(argument, args[++index]);
    else if (argument === "--name") {
      if (operation) throw new Error("choose exactly one of --name, --archive or --unarchive");
      name = requireValue(argument, args[++index]);
      operation = "name";
    } else if (argument === "--archive" || argument === "--unarchive") {
      if (operation) throw new Error("choose exactly one of --name, --archive or --unarchive");
      operation = argument.slice(2) as "archive" | "unarchive";
    } else if (argument === "--socket") socketPath = requireValue(argument, args[++index]);
    else if (argument === "--transport") {
      const value = requireValue(argument, args[++index]);
      if (value !== "auto" && value !== "http" && value !== "raw") throw new Error(`unsupported transport: ${value}`);
      transport = value;
    } else if (argument === "-h" || argument === "--help") {
      process.stdout.write(usage);
      process.exit(0);
    } else throw new Error(`unknown option: ${argument}`);
  }

  if (!threadId || !operation || (operation === "name" && !name)) throw new Error(usage.trim());
  await manageCodexThread({ threadId, operation, name, socketPath, transport });
} catch (error) {
  process.stderr.write(`muximo-codex-name: ${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(usage);
  process.exitCode = error instanceof Error && error.message === usage.trim() ? 2 : 1;
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}
