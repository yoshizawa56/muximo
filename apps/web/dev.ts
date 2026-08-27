#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { configurePortlessService, loadDevelopmentEnvironment, resolveRepositoryRoot } from "@muximo/portless-support";

const repositoryRoot = resolveRepositoryRoot();
loadDevelopmentEnvironment({ repositoryRoot });
configurePortlessService("web", { repositoryRoot });

const child = spawn("node", ["./node_modules/vite/bin/vite.js"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

let forwarding = false;
const forwardSignal = (signal: NodeJS.Signals) => {
  if (forwarding) return;
  forwarding = true;
  child.kill(signal);
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

await new Promise<void>((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code !== null) {
      process.exitCode = code;
    } else if (signal === "SIGINT") {
      process.exitCode = 130;
    } else if (signal === "SIGTERM") {
      process.exitCode = 143;
    } else {
      process.exitCode = 1;
    }
    resolvePromise();
  });
}).catch((error) => {
  console.error(`[web] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
