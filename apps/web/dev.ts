#!/usr/bin/env bun
import { spawn } from "node:child_process";

const environment = { ...process.env };
if (environment.HOST) {
  environment.VITE_DEV_HOST = environment.HOST;
}
if (environment.PORT) {
  environment.VITE_DEV_PORT = environment.PORT;
}
if (environment.PORTLESS_URL) {
  try {
    const hostname = new URL(environment.PORTLESS_URL).hostname;
    const allowedHosts = new Set(
      (environment.VITE_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    );
    allowedHosts.add(hostname);
    environment.VITE_ALLOWED_HOSTS = [...allowedHosts].join(",");
  } catch {
    // Vite reports malformed development URLs through its normal startup path.
  }
}

const child = spawn("node", ["./node_modules/vite/bin/vite.js"], {
  cwd: process.cwd(),
  env: environment,
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
    process.exitCode = code ?? signalExitCode(signal);
    resolvePromise();
  });
}).catch((error) => {
  console.error(`[web] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
