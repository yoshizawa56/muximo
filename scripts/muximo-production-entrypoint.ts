#!/usr/bin/env bun
import { runMuximoCli } from "../apps/muximo-cli/src/entrypoint.js";
import { hasMuximodBootstrap } from "../packages/muximod/src/launch.js";
import { runMuximodProcess } from "../packages/muximod/src/process-entrypoint.js";

if (hasMuximodBootstrap()) {
  process.exitCode = await runMuximodProcess();
} else {
  const status = await runMuximoCli(process.argv.slice(2), {
    buildMode: "production",
    env: process.env,
    input: process.stdin,
    out: process.stdout,
    err: process.stderr,
    muximodProcess: { executable: process.execPath, args: [] },
  });
  process.exitCode = status;
}
