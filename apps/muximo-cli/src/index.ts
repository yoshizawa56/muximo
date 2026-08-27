#!/usr/bin/env bun
import { createMigrationSchemaSynchronizer } from "@muximo/infrastructure";
import { runMuximoCli } from "./entrypoint.js";

const status = await runMuximoCli(process.argv.slice(2), {
  schemaSynchronizer: createMigrationSchemaSynchronizer(),
  includeDevelopmentCommands: false,
  env: process.env,
  input: process.stdin,
  out: process.stdout,
  err: process.stderr,
});
process.exitCode = status;

export { runMuximoCli } from "./entrypoint.js";
