import type { Readable, Writable } from "node:stream";
import { createCliComposition } from "./cli/compose.js";

export type CliEntrypointOptions = {
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  out?: Writable;
  err?: Writable;
};

/** Process boundary: argv/env/I/O invocation and exit status only. */
export async function runMuximoCli(args: readonly string[], options: CliEntrypointOptions = {}): Promise<number> {
  const composition = createCliComposition({
    env: options.env,
    input: options.input,
    io: {
      out: options.out ?? process.stdout,
      err: options.err ?? process.stderr,
    },
  });
  try {
    return await composition.execute(args);
  } catch (error) {
    (options.err ?? process.stderr).write(`muximo: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    composition.close();
  }
}
