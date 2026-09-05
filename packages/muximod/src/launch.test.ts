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
  parseMuximodBootstrap,
  readMuximodBootstrap,
} from "./launch.js";

const runtimeEnvironment = {
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
};

const bootstrapOptions: MuximodLaunchOptions = {
  instanceDirectory: "/tmp/muximod-instance",
  workingDirectory: "/tmp",
  runtimeEnvironment,
};

const serverConfig: MuximodConfig = {
  host: "127.0.0.1",
  port: 4317,
  instanceDirectory: "/tmp/muximod-instance",
  configFile: "/tmp/muximod-instance/config.json",
  hookOutputDirectory: "/tmp/muximod-instance/hooks",
  opencodeRegistryFile: "/tmp/muximod-instance/opencode-servers.json",
  pidFile: "/tmp/muximod-instance/muximod.pid",
  controlSocket: "/tmp/muximod-instance/muximod.sock",
  allowedOrigins: [],
  allowedRoots: ["/tmp"],
  logLevel: "info",
  logFile: "/tmp/muximod-instance/muximod.log",
  workingDirectory: "/tmp",
  runtimeEnvironment,
  enabledAgentBackends: ["codex"],
  defaultAgentBackend: "codex",
  opencodeServerUrl: null,
};

type BootstrapReadFixture = { path: string };
const bootstrapReadCases = [
  {
    name: "reads a bootstrap context from the private descriptor",
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
      ...serverConfig,
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
