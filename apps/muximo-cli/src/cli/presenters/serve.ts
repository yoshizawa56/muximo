import type { CliIo } from "../commands/types.js";
import type { ServeResult } from "../handlers/system.js";

export function presentServeResult(result: ServeResult, io: CliIo): number {
  if (result.command === "tailscale") {
    if (result.result.stderr) io.err.write(sanitizeProviderOutput(result.result.stderr));
    io.out.write(`[muximo-cli] muximod Tailscale Serve: ${result.result.url} -> ${result.result.localUrl}\n`);
    if (result.result.stdout) io.out.write(sanitizeProviderOutput(result.result.stdout));
    return 0;
  }
  if (result.command === "status") {
    const liveRoute = result.liveRoute;
    io.out.write("[muximo-cli] muximod Serve status:\n");
    io.out.write(`  local daemon: ${result.expectedLocalTarget} (running)\n`);
    io.out.write(
      `  external port: ${result.expectedExternalPort} (${result.state ? (liveRoute.endpointAvailable ? "available" : "not found") : "not configured"})\n`,
    );
    io.out.write(
      `  path: ${result.expectedPath} (${result.state ? (liveRoute.pathAvailable ? "available" : "not found") : "not configured"})\n`,
    );
    io.out.write(
      `  proxy target: ${result.expectedLocalTarget} (${liveRoute.proxyTargetMatches ? "matches" : "does not match"})\n`,
    );
    if (result.expectedPublicUrl) io.out.write(`  public URL: ${result.expectedPublicUrl}\n`);
    if (!result.state) {
      io.out.write("  route state: not configured\n");
      return 1;
    }
    io.out.write(
      `  route state: ${result.stateMatchesConfiguration ? "matches active daemon configuration" : "does not match active daemon configuration"}\n`,
    );
    if (result.providerError) io.err.write(sanitizeProviderOutput(result.providerError));
    if (!result.stateMatchesConfiguration) {
      io.err.write("[muximo-cli] saved Serve route does not match the active daemon configuration\n");
    }
    if (!liveRoute.proxyTargetMatches) {
      io.err.write(
        "[muximo-cli] live Tailscale Serve route does not match the configured external port, path, or proxy target\n",
      );
      return 1;
    }
    if (!result.stateMatchesConfiguration) return 1;
    return 0;
  }
  io.out.write(
    result.state === "stopped"
      ? `[muximo-cli] muximod Serve stopped${result.publicUrl ? `: ${result.publicUrl}` : ""}\n`
      : "[muximo-cli] muximod Serve route is already stopped\n",
  );
  return 0;
}

/**
 * Strips ANSI escape sequences and non-printable control characters from
 * provider-owned output before it reaches the terminal. URLs constructed by
 * muximo itself are left untouched.
 */
function sanitizeProviderOutput(value: string): string {
  // The escape character is composed at runtime so this source stays plain ASCII.
  const esc = String.fromCharCode(27);
  return value
    .replace(new RegExp(`${esc}\\][^\\x07${esc}]*?(?:\\x07|${esc}\\\\)`, "g"), "")
    .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, "g"), "")
    .replace(new RegExp(`${esc}\\([0-9A-Z]`, "g"), "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(new RegExp(esc, "g"), "");
}
