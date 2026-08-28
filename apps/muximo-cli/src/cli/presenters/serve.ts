import type { TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import type { CliIo } from "../commands/types.js";

export function presentServeResult(result: TailscaleServeResult, io: CliIo): number {
  if (result.stderr) io.err.write(result.stderr);
  io.out.write(`muximo serve tailscale: ${result.url ?? result.allowedOrigins.join(", ")} -> ${result.localUrl}\n`);
  if (result.stdout) io.out.write(result.stdout);
  return 0;
}
