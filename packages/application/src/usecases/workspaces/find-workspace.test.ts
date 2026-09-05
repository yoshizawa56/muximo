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
import { Effect, Layer } from "effect";
import { describe, it } from "vitest";
import { findWorkspace } from "./find-workspace.js";
import {
  type WorkspaceDirectory,
  type WorkspaceDirectoryService,
  type WorkspaceRepository,
  type WorkspaceRepositoryService,
  workspaceDirectoryLayer,
  workspaceRepositoryLayer,
} from "./workspace-services.js";

type FindWorkspaceFixture = {
  layer: Layer.Layer<WorkspaceRepositoryService | WorkspaceDirectoryService>;
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
  execute: (fixture, input) => findWorkspace(input.selector).pipe(Effect.provide(fixture.layer)),
  observe: () => ({}),
};

describe("workspace selector resolution", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createInvalidDirectoryFixture(): FixtureHandle<FindWorkspaceFixture> {
  return {
    fixture: createFixture(
      Object.assign(new Error("workspace directory is invalid"), {
        code: "invalid_directory",
        reason: "not_found",
      }),
    ),
  };
}

function createUnexpectedErrorFixture(): FixtureHandle<FindWorkspaceFixture> {
  return { fixture: createFixture(new Error("directory resolver unavailable")) };
}

function createFixture(directoryError: Error): FindWorkspaceFixture {
  const expected = createWorkspace();
  const repository: WorkspaceRepository = {
    findById: (id) => Effect.succeed(id === expected.id ? expected : undefined),
    list: () => Effect.succeed([expected]),
    insert: () => Effect.succeed(true),
    upsert: () => Effect.succeed(undefined),
    delete: () => Effect.succeed(undefined),
  };
  const directories: WorkspaceDirectory = {
    resolveDirectory: () => Effect.fail(directoryError),
    resolveHook: () => Effect.succeed("/work/project/hook.sh"),
  };
  return {
    layer: Layer.mergeAll(workspaceRepositoryLayer(repository), workspaceDirectoryLayer(directories)),
    expected,
  };
}

function createWorkspace(): FindWorkspaceResult {
  return Workspace.create({
    id: WorkspaceId.create("workspace-1"),
    rootPath: "/work/project",
    name: "project",
    isGit: true,
  });
}
