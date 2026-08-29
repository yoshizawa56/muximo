#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const turboEntrypoint = fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url));
const result = spawnSync(process.execPath, [turboEntrypoint, ...process.argv.slice(2)], {
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
