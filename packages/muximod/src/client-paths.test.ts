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
import { resolveMuximodClientPaths, validateMuximodControlSocketPath } from "./client-paths.js";

type Context = {};
type ResolveInput = {
  environment: NodeJS.ProcessEnv;
  overrides?: Parameters<typeof resolveMuximodClientPaths>[1];
};
type ResolvedPaths = ReturnType<typeof resolveMuximodClientPaths>;

const resolveCases = [
  {
    name: "uses the default client endpoint layout",
    input: { environment: { HOME: "/home/test" } },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/home/test/.local/state/muximo",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/home/test/.local/state/muximo/muximod.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sock",
      }),
    ],
  },
  {
    name: "applies client endpoint overrides without exposing a database path",
    input: {
      environment: { MUXIMOD_INSTANCE_DIR: "/tmp/muximo/main" },
    },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/tmp/muximo/main",
        hookOutputDirectory: "/tmp/muximo/main/hooks",
        pidFile: "/tmp/muximo/main/muximod.pid",
        controlSocket: "/tmp/muximo/main/muximod.sock",
      }),
    ],
  },
  {
    name: "resolves relative client paths against the supplied command directory",
    input: {
      environment: { MUXIMOD_INSTANCE_DIR: "state" },
      overrides: {
        baseDirectory: "/workspace/project",
      },
    },
    assert: [
      returns<Context, ResolvedPaths>({
        instanceDirectory: "/workspace/project/state",
        hookOutputDirectory: "/workspace/project/state/hooks",
        pidFile: "/workspace/project/state/muximod.pid",
        controlSocket: "/workspace/project/state/muximod.sock",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ResolveInput, ResolvedPaths, Context>[];

const resolveTable: OperationTable<undefined, "default", ResolveInput, ResolvedPaths, Context> = {
  defaultFixture: noFixture(),
  cases: resolveCases,
  execute: (_fixture, input) => resolveMuximodClientPaths(input.environment, input.overrides),
  observe: () => ({}),
};

type ValidateInput = { path: string };
const validateCases = [
  {
    name: "rejects control socket paths that cannot fit the Unix socket address",
    input: { path: resolveMuximodClientPaths({ MUXIMOD_INSTANCE_DIR: `/tmp/${"a".repeat(120)}` }).controlSocket },
    assert: [hasError<Context, undefined>({ message: /control socket path is too long/ })],
  },
] satisfies readonly OperationCase<"default", ValidateInput, undefined, Context>[];

const validateTable: OperationTable<undefined, "default", ValidateInput, undefined, Context> = {
  defaultFixture: noFixture(),
  cases: validateCases,
  execute: (_fixture, input) => {
    validateMuximodControlSocketPath(input.path);
  },
  observe: () => ({}),
};

describe("muximod client paths", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, resolveTable);
  runOperationTable(register, validateTable);
});
