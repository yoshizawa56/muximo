#!/usr/bin/env bun
import { createMigrationSchemaSynchronizer } from "@muximo/infrastructure";
import { runMuximod } from "./entrypoint.js";

await runMuximod({ schemaSynchronizer: createMigrationSchemaSynchronizer() });
