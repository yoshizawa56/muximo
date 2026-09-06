import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuximodConfigurationStatus } from "@muximo/contract/control";
import {
  defaultMuximoConfig,
  type MuximoConfig,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "@muximo/instance-contract";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createMuximodConfigurationStatusReader, type MuximodConfigResolutionContext } from "./config-status.js";

type StatusInput = "same" | "changed" | "invalid" | "missing";
type StatusFixture = {
  root: string;
  configFile: string;
  startupConfig: MuximoConfig;
  resolution: MuximodConfigResolutionContext;
  readStatus: () => MuximodConfigurationStatus;
};
type StatusContext = { state: string; changedKeys: readonly string[] };

const cases = [
  {
    name: "treats equivalent resolved paths and default workspace roots as current",
    input: "same" as const,
    assert: [
      hasObserved<StatusContext, StatusContext>("state", "current"),
      hasObserved<StatusContext, StatusContext>("changedKeys", []),
    ],
  },
  {
    name: "reports only the changed configuration keys",
    input: "changed" as const,
    assert: [
      hasObserved<StatusContext, StatusContext>("state", "restart_recommended"),
      hasObserved<StatusContext, StatusContext>("changedKeys", ["daemon.port", "serve.tailscale.enabled"]),
    ],
  },
  {
    name: "keeps a malformed on-disk file from affecting daemon status reads",
    input: "invalid" as const,
    assert: [
      hasObserved<StatusContext, StatusContext>("state", "unavailable"),
      hasObserved<StatusContext, StatusContext>("changedKeys", []),
    ],
  },
  {
    name: "treats a missing file as the normalized default configuration",
    input: "missing" as const,
    assert: [
      hasObserved<StatusContext, StatusContext>("state", "restart_recommended"),
      hasObserved<StatusContext, StatusContext>("changedKeys", ["workspace.roots", "agents.executables.codex"]),
    ],
  },
] satisfies readonly OperationCase<"default", StatusInput, StatusContext, StatusContext>[];

const table: OperationTable<StatusFixture, "default", StatusInput, StatusContext, StatusContext> = {
  defaultFixture: () => {
    const fixture = createFixture();
    return { fixture, cleanup: () => rmSync(fixture.root, { recursive: true, force: true }) };
  },
  cases,
  execute: (fixture, input) => {
    writeCandidate(fixture, input);
    const result = fixture.readStatus();
    return { state: result.state, changedKeys: result.changedKeys };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { state: "error", changedKeys: [] }),
};

describe("muximod configuration status", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(): StatusFixture {
  const root = mkdtempSync(join(tmpdir(), "muximod-config-status-test-"));
  const configFile = join(root, "config.json");
  let startupConfig = defaultMuximoConfig();
  startupConfig = setMuximoConfigValue(startupConfig, "workspace.roots", ["~/work"]);
  startupConfig = setMuximoConfigValue(startupConfig, "agents.executables.codex", "bin/codex");
  writeMuximoConfig(configFile, startupConfig);
  const resolution = { workingDirectory: "/workspace/project", homeDirectory: "/home/test" };
  return {
    root,
    configFile,
    startupConfig,
    resolution,
    readStatus: createMuximodConfigurationStatusReader({ configFile, startupConfig, resolution }),
  };
}

function writeCandidate(fixture: StatusFixture, input: StatusInput): void {
  if (input === "missing") {
    unlinkSync(fixture.configFile);
    return;
  }
  if (input === "invalid") {
    writeFileSync(fixture.configFile, "{ invalid", "utf8");
    return;
  }
  let candidate = fixture.startupConfig;
  if (input === "same") {
    candidate = setMuximoConfigValue(candidate, "workspace.roots", ["/home/test/work"]);
    candidate = setMuximoConfigValue(candidate, "agents.executables.codex", "/workspace/project/bin/codex");
  } else {
    candidate = setMuximoConfigValue(candidate, "daemon.port", 4318);
    candidate = setMuximoConfigValue(candidate, "serve.tailscale.enabled", true);
  }
  writeMuximoConfig(fixture.configFile, candidate);
}
