import type { CliIo } from "../commands/types.js";
import type { ServeResult } from "../handlers/system.js";

export function presentServeResult(result: ServeResult, io: CliIo): number {
  if (result.command === "tailscale") {
    if (result.result.stderr) io.err.write(result.result.stderr);
    io.out.write(`[muximo-cli] muximod Tailscale Serve: ${result.result.url} -> ${result.result.localUrl}\n`);
    if (result.result.stdout) io.out.write(result.result.stdout);
    return 0;
  }
  if (result.command === "status") {
    if (!result.state) {
      io.out.write("[muximo-cli] muximod Serve route is not configured\n");
      return 1;
    }
    io.out.write(`[muximo-cli] muximod Serve route: ${result.state.publicUrl}\n`);
    if (result.providerOutput) io.out.write(result.providerOutput);
    if (result.providerError) io.err.write(result.providerError);
    if (result.routeAvailable === false) {
      io.err.write("[muximo-cli] muximod Serve route state does not match the live provider configuration\n");
      return 1;
    }
    return 0;
  }
  io.out.write(
    result.state === "stopped"
      ? `[muximo-cli] muximod Serve stopped${result.publicUrl ? `: ${result.publicUrl}` : ""}\n`
      : "[muximo-cli] muximod Serve route is already stopped\n",
  );
  return 0;
}
