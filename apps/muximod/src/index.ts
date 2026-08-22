#!/usr/bin/env bun
import { errorMessage } from "@muximo/infrastructure";
import { runMuximodCommand, startMuximod } from "./daemon.js";

const args = process.argv.slice(2);

// The package entrypoint is the foreground runtime used by the dev supervisor
// and service managers. The unified `muximo daemon start` command is the
// user-facing lifecycle command and backgrounds this runtime through the
// daemon module.
try {
  if (
    args.length === 0
    || (
      !args.includes("-h")
      && !args.includes("--help")
      && (args[0] === "start" || args[0]?.startsWith("-"))
    )
  ) {
    await startMuximod(args);
  } else {
    await runMuximodCommand(args[0] === "daemon" ? args.slice(1) : args);
  }
} catch (error) {
  process.stderr.write(`muximod: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
