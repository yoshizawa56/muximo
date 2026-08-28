#!/usr/bin/env bun
import { runMuximod } from "./entrypoint.js";
import { readMuximodBootstrap } from "./launch.js";

await runMuximod(readMuximodBootstrap());
