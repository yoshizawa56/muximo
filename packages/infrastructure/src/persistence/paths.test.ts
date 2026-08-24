import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolveMuximodPaths, validateMuximodControlSocketPath } from "./paths.js";

type Context = {};
type ResolveInput = { environment: NodeJS.ProcessEnv; overrides?: Parameters<typeof resolveMuximodPaths>[1] };
type ResolvedPaths = ReturnType<typeof resolveMuximodPaths>;

const longInstanceDirectory = `/tmp/${"a".repeat(120)}`;
const resolveCases = [
  {
    name: "keeps the legacy default layout when no profile is configured",
    input: { environment: { HOME: "/home/test" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/home/test/.local/state/muximo",
        databaseFile: "/home/test/.local/state/muximo/muximod.sqlite",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/home/test/.local/state/muximo/muximod.sqlite.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sqlite.control.sock",
      }),
    ],
  },
  {
    name: "derives all normal paths from one instance directory",
    input: { environment: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/tmp/muximo/main",
        databaseFile: "/tmp/muximo/main/muximod.sqlite",
        hookOutputDirectory: "/tmp/muximo/main/hooks",
        pidFile: "/tmp/muximo/main/muximod.sqlite.pid",
        controlSocket: "/tmp/muximo/main/muximod.sock",
      }),
    ],
  },
  {
    name: "allows explicit leaf paths as advanced overrides",
    input: {
      environment: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" },
      overrides: {
        databaseFile: "/var/lib/muximo/muximod.sqlite",
        hookOutputDirectory: "/tmp/muximo/hooks",
        pidFile: "/tmp/muximo/run/muximod.pid",
        controlSocket: "/tmp/muximo/run/muximod.sock",
      },
    },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/tmp/muximo/main",
        databaseFile: "/var/lib/muximo/muximod.sqlite",
        hookOutputDirectory: "/tmp/muximo/hooks",
        pidFile: "/tmp/muximo/run/muximod.pid",
        controlSocket: "/tmp/muximo/run/muximod.sock",
      }),
    ],
  },
  {
    name: "preserves legacy database-derived paths without an instance directory",
    input: { environment: { HOME: "/home/test", MUXIMOD_DB_FILE: "/tmp/legacy.sqlite" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/home/test/.local/state/muximo",
        databaseFile: "/tmp/legacy.sqlite",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/tmp/legacy.sqlite.pid",
        controlSocket: "/tmp/legacy.sqlite.control.sock",
      }),
    ],
  },
  {
    name: "uses memory-specific runtime names",
    input: { environment: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/test" }, overrides: { databaseFile: ":memory:" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/tmp/muximo/test",
        databaseFile: ":memory:",
        hookOutputDirectory: "/tmp/muximo/test/hooks",
        pidFile: "/tmp/muximo/test/muximod.pid",
        controlSocket: "/tmp/muximo/test/muximod.sock",
      }),
    ],
  },
  {
    name: "does not redirect an empty instance variable into the current directory",
    input: { environment: { HOME: "/home/test", MUXIMOD_INSTANCE_DIR: "" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/home/test/.local/state/muximo",
        databaseFile: "/home/test/.local/state/muximo/muximod.sqlite",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/home/test/.local/state/muximo/muximod.sqlite.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sqlite.control.sock",
      }),
    ],
  },
  {
    name: "does not redirect a whitespace instance variable into the current directory",
    input: { environment: { HOME: "/home/test", MUXIMOD_INSTANCE_DIR: "   " } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/home/test/.local/state/muximo",
        databaseFile: "/home/test/.local/state/muximo/muximod.sqlite",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/home/test/.local/state/muximo/muximod.sqlite.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sqlite.control.sock",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ResolveInput, ResolvedPaths, Context>[];

const resolveTable: OperationTable<undefined, "default", ResolveInput, ResolvedPaths, Context> = {
  defaultFixture: noFixture(),
  cases: resolveCases,
  execute: (_fixture, input) => resolveMuximodPaths(input.environment, input.overrides),
  observe: () => ({}),
};

type ValidateInput = { path: string };
const validateCases = [
  {
    name: "rejects control socket paths that cannot fit the Unix socket address",
    input: { path: resolveMuximodPaths({ MUXIMOD_INSTANCE_DIR: longInstanceDirectory }).controlSocket },
    assert: [hasError<Context, undefined>({ message: /control socket path is too long/ })],
  },
] satisfies readonly OperationCase<"default", ValidateInput, undefined, Context>[];

const validateTable: OperationTable<undefined, "default", ValidateInput, undefined, Context> = {
  defaultFixture: noFixture(),
  cases: validateCases,
  execute: (_fixture, input) => {
    validateMuximodControlSocketPath(input.path);
    return undefined;
  },
  observe: () => ({}),
};

describe("muximod instance paths", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, resolveTable);
  runOperationTable(register, validateTable);
});
