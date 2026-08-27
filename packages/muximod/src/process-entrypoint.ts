#!/usr/bin/env bun
import { runMuximod } from "./entrypoint.js";
import { parseMuximodBootstrap } from "./launch.js";

await runMuximod(parseMuximodBootstrap(process.env.MUXIMO_MUXIMOD_BOOTSTRAP));
