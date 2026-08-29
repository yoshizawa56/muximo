#!/usr/bin/env bun
import { runMuximoCli } from "./entrypoint.js";

const status = await runMuximoCli(process.argv.slice(2), {
  env: process.env,
  input: process.stdin,
  out: process.stdout,
  err: process.stderr,
});
process.exitCode = status;

export { runMuximoCli } from "./entrypoint.js";
