#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const binary = resolve(process.env.MUXIMO_RELEASE_BINARY ?? join(homedir(), ".local", "libexec", "muximo", "muximo"));

if (!existsSync(binary)) {
  process.stderr.write(
    `${[
      `muximo: production binary not found: ${binary}`,
      "muximo: install the latest stable release with 'bun run muximo:install' or set MUXIMO_RELEASE_BINARY",
      "muximo: use 'mise muximo --env <profile>' for source-based profile commands",
    ].join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  const child = spawn(binary, process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`muximo: could not start production binary: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
