import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  completeExecutablePath,
  discoverAgentExecutableCandidates,
  type ExecutableCandidate,
  type ExecutableDiscoveryContext,
  executableValidationMessage,
  isExecutableReference,
  recommendedTailscaleExecutable,
} from "./path-completion.js";

type PathOperation =
  | { type: "discover"; configuredValue: string }
  | { type: "validate"; value: string }
  | { type: "complete"; value: string }
  | { type: "recommend"; platform: NodeJS.Platform };
type PathResult = {
  candidates: readonly ExecutableCandidate[];
  valid: boolean;
  message: string | undefined;
  completions: readonly string[];
  recommendation: string;
};
type PathContext = PathResult;

const cases = [
  {
    name: "discovers a configured executable before the PATH executable",
    input: { type: "discover", configuredValue: "custom/codex" },
    assert: [
      hasObserved<PathContext, PathResult>("candidates", [
        { value: "custom/codex", source: "configured" },
        { value: "bin/codex", source: "path" },
      ]),
    ],
  },
  {
    name: "rejects a missing command",
    input: { type: "validate", value: "missing" },
    assert: [
      hasObserved<PathContext, PathResult>("valid", false),
      hasObserved<PathContext, PathResult>("message", "Executable was not found or is not executable: missing"),
    ],
  },
  {
    name: "rejects a non-executable file",
    input: { type: "validate", value: "./bin/not-executable" },
    assert: [
      hasObserved<PathContext, PathResult>("valid", false),
      hasObserved<PathContext, PathResult>(
        "message",
        "Executable was not found or is not executable: ./bin/not-executable",
      ),
    ],
  },
  {
    name: "completes a home-relative executable path",
    input: { type: "complete", value: "~/bin/co" },
    assert: [hasObserved<PathContext, PathResult>("completions", ["~/bin/codex"])],
  },
  {
    name: "uses the bundled macOS Tailscale path as the platform recommendation",
    input: { type: "recommend", platform: "darwin" as const },
    assert: [
      hasObserved<PathContext, PathResult>("recommendation", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
    ],
  },
] satisfies readonly OperationCase<"default", PathOperation, PathResult, PathContext>[];

const table: OperationTable<ExecutableDiscoveryContext, "default", PathOperation, PathResult, PathContext> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-path-completion-"));
    const bin = join(root, "bin");
    const custom = join(root, "custom");
    mkdirSync(bin, { recursive: true });
    mkdirSync(custom, { recursive: true });
    writeExecutable(join(bin, "codex"));
    writeExecutable(join(custom, "codex"));
    writeFileSync(join(bin, "not-executable"), "not executable\n", { mode: 0o600 });
    return {
      fixture: {
        cwd: root,
        environment: { HOME: root, PATH: bin },
        platform: "linux",
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  },
  cases,
  execute: (fixture, input) => {
    switch (input.type) {
      case "discover":
        return {
          candidates: discoverAgentExecutableCandidates("codex", fixture, input.configuredValue),
          valid: false,
          message: undefined,
          completions: [],
          recommendation: "",
        };
      case "validate": {
        const message = executableValidationMessage(input.value, fixture);
        return {
          candidates: [],
          valid: isExecutableReference(input.value, fixture),
          message,
          completions: [],
          recommendation: "",
        };
      }
      case "complete":
        return {
          candidates: [],
          valid: false,
          message: undefined,
          completions: completeExecutablePath(input.value, fixture),
          recommendation: "",
        };
      case "recommend":
        return {
          candidates: [],
          valid: false,
          message: undefined,
          completions: [],
          recommendation: recommendedTailscaleExecutable(input.platform),
        };
    }
  },
  observe: (fixture, result) => {
    if (!result.ok) throw result.error;
    return {
      ...result.value,
      candidates: result.value.candidates.map((candidate) => ({
        ...candidate,
        value: candidate.value.startsWith(`${fixture.cwd}/`)
          ? candidate.value.slice(fixture.cwd.length + 1)
          : candidate.value,
      })),
    };
  },
};

describe("CLI executable discovery and path completion", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function writeExecutable(filePath: string): void {
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(filePath, 0o700);
}
