import { Readable, Writable } from "node:stream";
import { relative, resolve } from "node:path";
import { describe, it } from "vitest";
import {
  hasObserved,
  noFixture,
  returns,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { PairDevice } from "@muximo/application";
import { PairCommand, parsePairCommandOptions, type PairDeviceRuntime, type ParsedPairCommandOptions } from "./pair-command.js";

const resolveDefaultControlSocket = (env: NodeJS.ProcessEnv): string => `${env.MUXIMOD_INSTANCE_DIR ?? "/tmp/muximo"}/muximod.sock`;
const validateControlSocket = (path: string): void => {
  if (!path || path === "/" || path.endsWith("/")) throw new Error(`invalid control socket path: ${path}`);
};

class CaptureOutput extends Writable {
  public value = "";
  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void { this.value += chunk.toString(); callback(); }
}

type PairCommandFixture = {
  out: CaptureOutput;
  received: unknown;
  closed: boolean;
  constructed: boolean;
  controlSocket: string | null;
  display: string | null;
};
type PairCommandInput = { args: string[] };
type PairCommandContext = Omit<PairCommandFixture, "out"> & { output: string };
type PairCommandKey = "approved" | "help";
type CommandFixture = PairCommandFixture & { command: PairCommand };

const createPairCommandFixture = (kind: PairCommandKey): (() => FixtureHandle<CommandFixture>) => () => {
  const out = new CaptureOutput();
  const fixture: PairCommandFixture = { out, received: undefined, closed: false, constructed: false, controlSocket: null, display: null };
  const runtime: PairDeviceRuntime = {
    useCase: {
      execute: async (input) => {
        fixture.received = input;
        return { status: "approved", deviceId: "device-1" };
      },
    } as PairDevice,
    close: () => { fixture.closed = true; },
  };
  const command = new PairCommand({
    ...(kind === "approved" ? { env: { MUXIMOD_CONTROL_SOCKET: "/tmp/muximod.control.sock" } } : {}),
    io: { out, input: Readable.from([]) },
    resolveMuximodBaseUrl: async () => "https://muximod.example",
    resolveDefaultControlSocket,
    validateControlSocket,
    createRuntime: async (options) => {
      fixture.constructed = true;
      fixture.controlSocket = options.controlSocket ?? null;
      fixture.display = options.display;
      if (kind === "help") throw new Error("must not be called");
      return runtime;
    },
  });
  return { fixture: Object.assign(fixture, { command }) };
};

const commandCases = [
  {
    name: "maps command options into the injected use case",
    fixture: "approved",
    input: { args: ["--muximod-base-url", "https://muximod.example"] },
    assert: [
      returns<PairCommandContext, number>(0),
      hasObserved<PairCommandContext, number>("received", { muximodBaseUrl: "https://muximod.example" }),
      hasObserved<PairCommandContext, number>("output", "Approved. deviceId: device-1\n"),
      hasObserved<PairCommandContext, number>("closed", true),
      hasObserved<PairCommandContext, number>("controlSocket", "/tmp/muximod.control.sock"),
      hasObserved<PairCommandContext, number>("display", "browser"),
    ],
  },
  {
    name: "does not construct runtime dependencies for help",
    fixture: "help",
    input: { args: ["--help"] },
    assert: [
      returns<PairCommandContext, number>(0),
      hasObserved<PairCommandContext, number>("constructed", false),
      hasObserved<PairCommandContext, number>("output", "Usage: muximo pair [--open|--terminal] [--without-serve] [--muximod-base-url URL] [--control-socket PATH]\n"),
    ],
  },
] satisfies readonly OperationCase<PairCommandKey, PairCommandInput, number, PairCommandContext>[];

const commandTable: OperationTable<CommandFixture, PairCommandKey, PairCommandInput, number, PairCommandContext> = {
  defaultFixture: createPairCommandFixture("approved"),
  fixtures: {
    approved: createPairCommandFixture("approved"),
    help: createPairCommandFixture("help"),
  },
  cases: commandCases,
  execute: (fixture, input) => fixture.command.execute(input.args),
  observe: (fixture) => ({ output: fixture.out.value, received: fixture.received, closed: fixture.closed, constructed: fixture.constructed, controlSocket: fixture.controlSocket, display: fixture.display }),
};

type ParseInput = { args: string[]; env: NodeJS.ProcessEnv };
const parseCases = [
  {
    name: "derives the control socket from the instance directory",
    input: { args: ["--muximod-base-url", "https://muximod.example"], env: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: "/tmp/muximo/main/muximod.sock", muximodBaseUrl: "https://muximod.example", withoutServe: false, display: "browser" })],
  },
  {
    name: "allows the default Serve resolver to provide the endpoint",
    input: { args: [], env: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: "/tmp/muximo/main/muximod.sock", muximodBaseUrl: undefined, withoutServe: false, display: "browser" })],
  },
  {
    name: "selects the local endpoint mode explicitly",
    input: { args: ["--without-serve"], env: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: "/tmp/muximo/main/muximod.sock", muximodBaseUrl: undefined, withoutServe: true, display: "browser" })],
  },
  {
    name: "normalizes a relative control socket override",
    input: { args: ["--control-socket", relative(process.cwd(), "/tmp/muximo-muximod.sock"), "--muximod-base-url", "https://muximod.example"], env: {} },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: resolve("/tmp/muximo-muximod.sock"), muximodBaseUrl: "https://muximod.example", withoutServe: false, display: "browser" })],
  },
  {
    name: "selects terminal QR output explicitly",
    input: { args: ["--terminal"], env: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: "/tmp/muximo/main/muximod.sock", muximodBaseUrl: undefined, withoutServe: false, display: "terminal" })],
  },
  {
    name: "accepts an explicit browser QR option",
    input: { args: ["--open"], env: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [returns<{}, ParsedPairCommandOptions>({ controlSocket: "/tmp/muximo/main/muximod.sock", muximodBaseUrl: undefined, withoutServe: false, display: "browser" })],
  },
] satisfies readonly OperationCase<"default", ParseInput, ParsedPairCommandOptions, {}>[];

const parseTable: OperationTable<undefined, "default", ParseInput, ParsedPairCommandOptions, {}> = {
  defaultFixture: noFixture(),
  cases: parseCases,
  execute: (_fixture, input) => parsePairCommandOptions(input.args, input.env, resolveDefaultControlSocket, validateControlSocket),
  observe: () => ({}),
};

describe("muximo pair CLI adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, parseTable);
  runOperationTable(register, commandTable);
});
