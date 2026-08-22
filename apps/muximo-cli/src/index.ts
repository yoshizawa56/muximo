#!/usr/bin/env bun
import { createLogger } from "@muximo/infrastructure";
import { parseGlobalOptions } from "./global-options.js";
import { runMuximoCli } from "./entrypoint.js";

export { parseGlobalOptions } from "./global-options.js";
export type { ParsedGlobalOptions } from "./global-options.js";

const parsed = parseGlobalOptions(process.argv.slice(2));
const logger = createLogger({
  service: "muximo-cli",
  mode: "attached",
  level: parsed.verbose ? "debug" : "warn",
  output: process.stderr,
  showStack: parsed.verbose,
});

await runMuximoCli(parsed.args, logger);
