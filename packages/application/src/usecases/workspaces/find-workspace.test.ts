import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { WorkspaceDirectoryPort } from "../../ports/workspace.js";
import { findWorkspace } from "./find-workspace.js";

type FindWorkspaceFixture = {
  repository: WorkspaceRepository;
  directories: WorkspaceDirectoryPort;
  expected: ReturnType<typeof Workspace.create>;
};
type FindWorkspaceInput = { selector: string };
type FindWorkspaceResult = ReturnType<typeof Workspace.create>;
type EmptyContext = {};

const cases = [
  {
    name: "falls through to name matching for an invalid directory selector",
    fixture: "invalid-directory",
    input: { selector: "project" },
    assert: [returns<EmptyContext, FindWorkspaceResult>(createWorkspace())],
  },
  {
    name: "propagates an unexpected directory resolution failure",
    fixture: "unexpected-error",
    input: { selector: "project" },
    assert: [hasError<EmptyContext, FindWorkspaceResult>({ message: "directory resolver unavailable" })],
  },
] satisfies readonly OperationCase<
  "invalid-directory" | "unexpected-error",
  FindWorkspaceInput,
  FindWorkspaceResult,
  EmptyContext
>[];

const table: OperationTable<
  FindWorkspaceFixture,
  "invalid-directory" | "unexpected-error",
  FindWorkspaceInput,
  FindWorkspaceResult,
  EmptyContext
> = {
  defaultFixture: createInvalidDirectoryFixture,
  fixtures: {
    "invalid-directory": createInvalidDirectoryFixture,
    "unexpected-error": createUnexpectedErrorFixture,
  },
  cases,
  execute: (fixture, input) => findWorkspace(fixture.repository, fixture.directories, input.selector),
  observe: () => ({}),
};

describe("workspace selector resolution", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createInvalidDirectoryFixture(): FixtureHandle<FindWorkspaceFixture> {
  return { fixture: createFixture({ code: "invalid_directory", reason: "not_found" }) };
}

function createUnexpectedErrorFixture(): FixtureHandle<FindWorkspaceFixture> {
  return { fixture: createFixture(new Error("directory resolver unavailable")) };
}

function createFixture(directoryError: unknown): FindWorkspaceFixture {
  const expected = createWorkspace();
  const repository: WorkspaceRepository = {
    findById: async (id) => (id === expected.id ? expected : undefined),
    list: async () => [expected],
    insert: async () => true,
    upsert: async () => undefined,
    delete: async () => undefined,
  };
  const directories: WorkspaceDirectoryPort = {
    resolveDirectory: () => {
      throw directoryError;
    },
    resolveHook: () => "/work/project/hook.sh",
  };
  return { repository, directories, expected };
}

function createWorkspace(): FindWorkspaceResult {
  return Workspace.create({
    id: WorkspaceId.create("workspace-1"),
    rootPath: "/work/project",
    name: "project",
    isGit: true,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  });
}
