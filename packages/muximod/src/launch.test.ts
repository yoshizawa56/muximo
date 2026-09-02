import { mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type MuximodConfig,
  type MuximodLaunchOptions,
  muximodConfigSchema,
  muximodConfigurationFingerprint,
  parseMuximodBootstrap,
  readMuximodBootstrap,
} from "./launch.js";

const bootstrapOptions: MuximodLaunchOptions = {
  schemaMode: "migrate",
  config: {
    host: "127.0.0.1",
    port: 4317,
    instanceDirectory: "/tmp/muximod-instance",
    hookOutputDirectory: "/tmp/muximod-instance/hooks",
    pidFile: "/tmp/muximod-instance/muximod.pid",
    controlSocket: "/tmp/muximod-instance/muximod.sock",
    allowedOrigins: [],
    allowedRoots: ["/tmp"],
    logLevel: "info",
    workingDirectory: "/tmp",
    runtimeEnvironment: {
      homeDirectory: null,
      path: null,
      codexHome: null,
      claudeConfigDirectory: null,
      tailscaleBinary: null,
      tmuxPane: null,
      tmuxSocket: null,
      worktreeId: null,
      worktreeRoot: null,
      muximoCommand: null,
      codexRemote: "unix://",
      codexBinary: null,
      claudeBinary: null,
      opencodeBinary: null,
      migrationsDirectory: null,
    },
  },
};

type BootstrapReadFixture = { path: string };
const bootstrapReadCases = [
  {
    name: "reads a validated launch configuration from the private descriptor",
    input: undefined,
    assert: [returns<{}, MuximodLaunchOptions>(bootstrapOptions)],
  },
] satisfies readonly OperationCase<"default", undefined, MuximodLaunchOptions, {}>[];

const bootstrapReadTable: OperationTable<BootstrapReadFixture, "default", undefined, MuximodLaunchOptions, {}> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximod-bootstrap-test-"));
    const path = join(root, "options.json");
    writeFileSync(path, JSON.stringify(bootstrapOptions), { mode: 0o600 });
    return { fixture: { path }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  },
  cases: bootstrapReadCases,
  execute: (fixture) => readMuximodBootstrap(openSync(fixture.path, "r")),
  observe: () => ({}),
};

const bootstrapSizeCases = [
  {
    name: "rejects a bootstrap payload above the process boundary limit",
    input: "oversized" as const,
    assert: [hasError<{}, MuximodLaunchOptions>({ message: /payload exceeds/ })],
  },
] satisfies readonly OperationCase<"default", "oversized", MuximodLaunchOptions, {}>[];

const bootstrapSizeTable: OperationTable<undefined, "default", "oversized", MuximodLaunchOptions, {}> = {
  defaultFixture: noFixture(),
  cases: bootstrapSizeCases,
  execute: () => parseMuximodBootstrap("x".repeat(1024 * 1024 + 1)),
  observe: () => ({}),
};

describe("muximod process bootstrap", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, bootstrapReadTable);
  runOperationTable(register, bootstrapSizeTable);
});

type FingerprintInput =
  | "same"
  | "different-origin"
  | "different-runtime"
  | "different-schema-mode"
  | "different-tmux-pane";
type FingerprintResult = { first: string; second: string };
type FingerprintContext = { equal: boolean; length: number };

const fingerprintCases = [
  {
    name: "keeps identical launch configurations reusable",
    input: "same" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", true), hasObserved("length", 64)],
  },
  {
    name: "changes when a browser origin changes",
    input: "different-origin" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
  {
    name: "changes when schema mode changes",
    input: "different-schema-mode" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
  {
    name: "changes when a daemon runtime environment value changes",
    input: "different-runtime" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
  {
    name: "keeps the daemon reusable across tmux panes",
    input: "different-tmux-pane" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", true)],
  },
] satisfies readonly OperationCase<"default", FingerprintInput, FingerprintResult, FingerprintContext>[];

const fingerprintTable: OperationTable<undefined, "default", FingerprintInput, FingerprintResult, FingerprintContext> =
  {
    defaultFixture: noFixture(),
    cases: fingerprintCases,
    execute: (_fixture, input) => {
      const first = muximodConfigurationFingerprint(bootstrapOptions);
      const secondOptions =
        input === "same"
          ? bootstrapOptions
          : input === "different-origin"
            ? { ...bootstrapOptions, config: { ...bootstrapOptions.config, allowedOrigins: ["http://web.example"] } }
            : input === "different-runtime"
              ? {
                  ...bootstrapOptions,
                  config: {
                    ...bootstrapOptions.config,
                    runtimeEnvironment: { ...bootstrapOptions.config.runtimeEnvironment, codexRemote: "https://codex" },
                  },
                }
              : input === "different-tmux-pane"
                ? {
                    ...bootstrapOptions,
                    config: {
                      ...bootstrapOptions.config,
                      runtimeEnvironment: { ...bootstrapOptions.config.runtimeEnvironment, tmuxPane: "%42" },
                    },
                  }
                : { schemaMode: "push" as const, config: bootstrapOptions.config };
      const second = muximodConfigurationFingerprint(secondOptions);
      return { first, second };
    },
    observe: (_fixture, result) => {
      if (!result.ok) return { equal: false, length: 0 };
      return { equal: result.value.first === result.value.second, length: result.value.first.length };
    },
  };

describe("muximod configuration identity", () => {
  runOperationTable(it as unknown as TestRegistrar, fingerprintTable);
});

type BindHostInput = "loopback" | "private" | "wildcard" | "public";
type BindHostContext = { host: string | null };

const bindHostCases = [
  {
    name: "accepts the default loopback bind address",
    input: "loopback" as const,
    assert: [hasObserved<BindHostContext, MuximodConfig>("host", "127.0.0.1")],
  },
  {
    name: "accepts an explicit private bind address",
    input: "private" as const,
    assert: [hasObserved<BindHostContext, MuximodConfig>("host", "192.168.50.10")],
  },
  {
    name: "rejects a wildcard bind address",
    input: "wildcard" as const,
    assert: [hasError<BindHostContext, MuximodConfig>({ message: /host must be localhost/ })],
  },
  {
    name: "rejects a public bind address",
    input: "public" as const,
    assert: [hasError<BindHostContext, MuximodConfig>({ message: /host must be localhost/ })],
  },
] satisfies readonly OperationCase<"default", BindHostInput, MuximodConfig, BindHostContext>[];

const bindHostTable: OperationTable<undefined, "default", BindHostInput, MuximodConfig, BindHostContext> = {
  defaultFixture: noFixture(),
  cases: bindHostCases,
  execute: (_fixture, input) =>
    muximodConfigSchema.parse({
      ...bootstrapOptions.config,
      host:
        input === "loopback"
          ? "127.0.0.1"
          : input === "private"
            ? "192.168.50.10"
            : input === "wildcard"
              ? "0.0.0.0"
              : "8.8.8.8",
    }),
  observe: (_fixture, result) => (result.ok ? { host: result.value.host } : { host: null }),
};

describe("muximod bind host validation", () => {
  runOperationTable(it as unknown as TestRegistrar, bindHostTable);
});
