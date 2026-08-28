#!/usr/bin/env bun
import { loadDevelopmentEnvironment, portlessServices, resolveRepositoryRoot, runPortlessService } from "./index.js";

const service = process.argv[2];
if (!portlessServices.includes(service as (typeof portlessServices)[number])) {
  console.error(`usage: portless-support <${portlessServices.join("|")}> [args...]`);
  process.exitCode = 2;
} else {
  try {
    const repositoryRoot = resolveRepositoryRoot();
    const environment = loadDevelopmentEnvironment({ repositoryRoot, environment: { ...process.env } });
    process.exitCode = await runPortlessService(service as (typeof portlessServices)[number], {
      repositoryRoot,
      environment,
      args: process.argv.slice(3),
    });
  } catch (error) {
    console.error(`[portless-support] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
