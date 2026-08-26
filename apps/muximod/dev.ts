#!/usr/bin/env bun
import { createPushSchemaSynchronizer } from "@muximo/infrastructure";
import { configurePortlessService, loadDevelopmentEnvironment, resolveRepositoryRoot } from "@muximo/portless-support";
import { ensureDevMuximodState } from "./src/dev-state.js";
import { runMuximod } from "./src/entrypoint.js";

const repositoryRoot = resolveRepositoryRoot();
loadDevelopmentEnvironment({ repositoryRoot });
configurePortlessService("muximod", { repositoryRoot });

await ensureDevMuximodState(process.env);
await runMuximod({
  schemaSynchronizer: createPushSchemaSynchronizer({ force: true }),
});
