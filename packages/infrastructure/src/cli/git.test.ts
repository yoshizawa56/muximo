import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { gitStatus, listUnmanagedFiles } from "./git.js";

type GitFixture = { root: string };
type GitInput = { operation: "status" | "unmanaged-files" };
type GitResult = string | string[];
type EmptyContext = {};

const cases = [
  {
    name: "rejects a status probe outside a git repository",
    input: { operation: "status" },
    assert: [hasError<EmptyContext, GitResult>({ message: /git -C/ })],
  },
  {
    name: "rejects unmanaged-file discovery outside a git repository",
    input: { operation: "unmanaged-files" },
    assert: [hasError<EmptyContext, GitResult>({ message: /git -C/ })],
  },
] satisfies readonly OperationCase<"default", GitInput, GitResult, EmptyContext>[];

const table: OperationTable<GitFixture, "default", GitInput, GitResult, EmptyContext> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-git-probe-"));
    return { fixture: { root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  },
  cases,
  execute: (fixture, input) =>
    input.operation === "status" ? gitStatus(fixture.root) : listUnmanagedFiles(fixture.root),
  observe: () => ({}),
};

describe("git command adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
