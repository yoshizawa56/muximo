import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { gitStatus, listIgnoredDirectories, listIgnoredFiles, listUnmanagedFiles } from "./git.js";

type GitFixture = { root: string };
type GitInput = { operation: "status" | "unmanaged-files" | "ignored-files" | "ignored-directories" };
type GitResult = string | string[];
type EmptyContext = {};
type GitFixtureKey = "default" | "nested" | "ignored";

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
  {
    name: "rejects ignored-file discovery outside a git repository",
    input: { operation: "ignored-files" },
    assert: [hasError<EmptyContext, GitResult>({ message: /git -C/ })],
  },
  {
    name: "rejects ignored-directory discovery outside a git repository",
    input: { operation: "ignored-directories" },
    assert: [hasError<EmptyContext, GitResult>({ message: /git -C/ })],
  },
  {
    name: "summarizes nested untracked files without expanding every file into status output",
    fixture: "nested",
    input: { operation: "status" },
    assert: [returns<EmptyContext, GitResult>("?? nested/\n")],
  },
  {
    name: "lists only files ignored by Git",
    fixture: "ignored",
    input: { operation: "ignored-files" },
    assert: [returns<EmptyContext, GitResult>([".env", "nested/secret.txt"])],
  },
  {
    name: "lists only wholly ignored directories",
    fixture: "ignored",
    input: { operation: "ignored-directories" },
    assert: [returns<EmptyContext, GitResult>(["nested"])],
  },
] satisfies readonly OperationCase<GitFixtureKey, GitInput, GitResult, EmptyContext>[];

const table: OperationTable<GitFixture, GitFixtureKey, GitInput, GitResult, EmptyContext> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-git-probe-"));
    return { fixture: { root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  },
  fixtures: {
    default: () => {
      const root = mkdtempSync(join(tmpdir(), "muximo-git-probe-"));
      return { fixture: { root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    },
    nested: () => {
      const root = mkdtempSync(join(tmpdir(), "muximo-git-probe-"));
      execFileSync("git", ["-C", root, "init", "-q"]);
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "nested", "one.txt"), "one\n");
      writeFileSync(join(root, "nested", "two.txt"), "two\n");
      return { fixture: { root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    },
    ignored: () => {
      const root = mkdtempSync(join(tmpdir(), "muximo-git-probe-"));
      execFileSync("git", ["-C", root, "init", "-q"]);
      writeFileSync(join(root, ".gitignore"), ".env\nnested/\n");
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, ".env"), "secret\n");
      writeFileSync(join(root, "nested", "secret.txt"), "secret\n");
      writeFileSync(join(root, "visible.txt"), "visible\n");
      return { fixture: { root }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    },
  },
  cases,
  execute: (fixture, input) =>
    input.operation === "status"
      ? gitStatus(fixture.root)
      : input.operation === "ignored-files"
        ? listIgnoredFiles(fixture.root)
        : input.operation === "ignored-directories"
          ? listIgnoredDirectories(fixture.root)
          : listUnmanagedFiles(fixture.root),
  observe: () => ({}),
};

describe("git command adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
