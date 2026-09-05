import type { Readable, Writable } from "node:stream";
import type { PairDeviceInput, PairDeviceResult } from "@muximo/application";
import { Effect } from "effect";

export type PairCommandIo = {
  out: Writable;
  input: Readable;
};

export type PairDisplay = "browser" | "terminal";

export type ResolvedPairCommandOptions = {
  controlSocket: string;
  muximodBaseUrl: string;
  display: PairDisplay;
};

export type PairDeviceRuntime = {
  useCase: {
    execute(input: PairDeviceInput): Effect.Effect<PairDeviceResult, Error, never>;
  };
  close(): void | Promise<void>;
};

export type PairDeviceRuntimeFactory = (
  options: ResolvedPairCommandOptions,
  io: PairCommandIo,
) => Promise<PairDeviceRuntime>;

export type PairCommandOptions = {
  io: PairCommandIo;
  createRuntime: PairDeviceRuntimeFactory;
};

/** Thin CLI adapter for the application-level pairing use case. */
export class PairCommand {
  public constructor(private readonly options: PairCommandOptions) {}

  public async execute(input: ResolvedPairCommandOptions): Promise<number> {
    const runtime = await this.options.createRuntime(input, this.options.io);
    try {
      const result = await Effect.runPromise(runtime.useCase.execute({ muximodBaseUrl: input.muximodBaseUrl }));
      if (result.status === "approved") {
        this.options.io.out.write(`Approved. deviceId: ${result.deviceId}\n`);
        return 0;
      }
      this.options.io.out.write("Pairing was rejected.\n");
      return 1;
    } finally {
      await runtime.close();
    }
  }
}
