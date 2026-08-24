import { Readable, Writable } from "node:stream";
import type { PairDevice } from "@muximo/application";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { PairCommand, type PairDeviceRuntime, type ResolvedPairCommandOptions } from "./pair-command.js";

class CaptureOutput extends Writable {
  public value = "";
  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

type Fixture = {
  out: CaptureOutput;
  command: PairCommand;
  received: unknown;
  closed: boolean;
};

type Context = Fixture & { output: string };
type Key = "approved" | "rejected" | "failed";

const createFixture = (key: Key) => () => {
  const out = new CaptureOutput();
  const fixture = { out, received: undefined as unknown, closed: false, command: undefined as PairCommand | undefined };
  const runtime: PairDeviceRuntime = {
    useCase: {
      execute: async (input) => {
        fixture.received = input;
        if (key === "failed") throw new Error("pairing transport failed");
        return key === "approved" ? { status: "approved", deviceId: "device-1" } : { status: "rejected" };
      },
    } as PairDevice,
    close: () => {
      fixture.closed = true;
    },
  };
  fixture.command = new PairCommand({
    io: { out, input: Readable.from([]) },
    createRuntime: async () => runtime,
  });
  return { fixture: fixture as Fixture };
};

const input: ResolvedPairCommandOptions = {
  controlSocket: "/tmp/muximod.sock",
  muximodBaseUrl: "https://muximod.example",
  display: "browser",
};

const cases = [
  {
    name: "dispatches an approved pairing result",
    fixture: "approved",
    input,
    assert: [
      returns<Context, number>(0),
      hasObserved<Context, number>("received", { muximodBaseUrl: "https://muximod.example" }),
      hasObserved<Context, number>("output", "Approved. deviceId: device-1\n"),
      hasObserved<Context, number>("closed", true),
    ],
  },
  {
    name: "returns a nonzero status for a rejected pairing",
    fixture: "rejected",
    input,
    assert: [
      returns<Context, number>(1),
      hasObserved<Context, number>("output", "Pairing was rejected.\n"),
      hasObserved<Context, number>("closed", true),
    ],
  },
  {
    name: "closes the runtime when pairing fails",
    fixture: "failed",
    input,
    assert: [
      hasError<Context, number>({ message: "pairing transport failed" }),
      hasObserved<Context, number>("closed", true),
    ],
  },
] satisfies readonly OperationCase<Key, ResolvedPairCommandOptions, number, Context>[];

const table: OperationTable<Fixture, Key, ResolvedPairCommandOptions, number, Context> = {
  defaultFixture: createFixture("approved"),
  fixtures: {
    approved: createFixture("approved"),
    rejected: createFixture("rejected"),
    failed: createFixture("failed"),
  },
  cases,
  execute: (fixture, options) => fixture.command.execute(options),
  observe: (fixture) => ({ ...fixture, output: fixture.out.value }),
};

describe("muximo pair CLI adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
