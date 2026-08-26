#!/usr/bin/env bun
import { createPushSchemaSynchronizer } from "@muximo/infrastructure";
import { loadDevelopmentEnvironment, resolveRepositoryRoot } from "@muximo/portless-support";
import { runMuximoCli } from "./src/entrypoint.js";

loadDevelopmentEnvironment({ repositoryRoot: resolveRepositoryRoot() });

const status = await runMuximoCli(process.argv.slice(2), {
  schemaSynchronizer: createPushSchemaSynchronizer({ force: true }),
  includeDevelopmentCommands: true,
  env: process.env,
  input: process.stdin,
  out: process.stdout,
  err: process.stderr,
});
process.exitCode = status;
