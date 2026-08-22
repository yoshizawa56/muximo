import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { hostname as osHostname, platform as osPlatform } from "node:os";
import type { MuximodTerminalEndpoint } from "@muximo/application";
import { buildTailscaleInvocation } from "./index.js";

/**
 * Resolves the local terminal endpoint at the infrastructure boundary. The
 * bounded synchronous probe is intentional: it runs during a request for a
 * small, local CLI lookup and keeps child-process I/O out of the composition
 * root and application layer.
 */
export async function getLocalTerminal(): Promise<MuximodTerminalEndpoint> {
  const host = osHostname();
  return {
    id: host,
    name: host.split(".")[0] || host,
    host,
    tailnetIp: readTailscaleIpv4() ?? host,
    state: "online",
    detail: `muximod - ${osPlatform()}`,
    lastSeen: "online now",
  };
}

function readTailscaleIpv4(): string | undefined {
  const invocation = buildTailscaleInvocation(process.env.TAILSCALE_BIN ?? "tailscale", ["ip", "-4"], process.env, process.platform, {
    allowShellFallback: false,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    env: invocation.environment,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 500,
  });
  const address = result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
  return isIP(address) === 4 ? address : undefined;
}
