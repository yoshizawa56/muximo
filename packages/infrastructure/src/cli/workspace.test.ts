import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRepository, WorkspaceResolutionInput } from "@muximo/application";
import { Workspace } from "@muximo/domain";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, it } from "vitest";
import { workspaceIdForPath } from "../workspace/selection.js";
import { realpathSafe } from "./filesystem.js";
import { WorkspaceResolverAdapter } from "./workspace.js";

type WorkspaceFixture = {
  root: string;
  targetPath: string;
  nestedTargetPath: string;
  otherPath: string;
  resolver: WorkspaceResolverAdapter;
};

type ResolverInput = WorkspaceResolutionInput;
type ResolverResult = Workspace;
type ResolverContext = {
  resolvedName: string;
  isTarget: boolean;
};
type FixtureKey = "default" | "managed" | "named-boundary";

const cases = [
  {
    name: "selects a registered workspace by name without consulting cwd",
    input: { workspace: "target", cwd: "missing" },
    assert: [hasObserved<ResolverContext, ResolverResult>("resolvedName", "target")],
  },
  {
    name: "selects a registered workspace by path",
    input: { workspace: "targetPath", cwd: "missing" },
    assert: [hasObserved<ResolverContext, ResolverResult>("isTarget", true)],
  },
  {
    name: "uses the supplied cwd when workspace is not explicitly selected",
    input: { cwd: "target" },
    assert: [hasObserved<ResolverContext, ResolverResult>("resolvedName", "target")],
  },
  {
    name: "selects a registered workspace for a cwd below its root",
    input: { cwd: "nestedTarget" },
    assert: [hasObserved<ResolverContext, ResolverResult>("resolvedName", "target")],
  },
  {
    name: "uses the managed workspace binding before resolving the caller cwd",
    fixture: "managed",
    input: { cwd: "missing" },
    assert: [hasObserved<ResolverContext, ResolverResult>("resolvedName", "target")],
  },
  {
    name: "validates a named workspace against the allowed directory boundary",
    fixture: "named-boundary",
    input: { workspace: "target" },
    assert: [hasError<ResolverContext, ResolverResult>({ message: "workspace root is outside the allowed roots" })],
  },
  {
    name: "does not accept an internal workspace id as a selector",
    input: { workspace: "workspace-id" },
    assert: [hasError<ResolverContext, ResolverResult>({ message: /workspace not found/iu })],
  },
] satisfies readonly OperationCase<FixtureKey, ResolverInput, ResolverResult, ResolverContext>[];

const table: OperationTable<WorkspaceFixture, FixtureKey, ResolverInput, ResolverResult, ResolverContext> = {
  defaultFixture: createFixture,
  fixtures: { default: createFixture, managed: createManagedFixture, "named-boundary": createNamedBoundaryFixture },
  cases,
  execute: (fixture, input) =>
    fixture.resolver.resolveCurrent({
      workspace: input.workspace === "targetPath" ? fixture.targetPath : input.workspace,
      cwd:
        input.cwd === "target"
          ? fixture.targetPath
          : input.cwd === "nestedTarget"
            ? fixture.nestedTargetPath
            : input.cwd === "missing"
              ? join(fixture.root, input.cwd)
              : input.cwd,
    }),
  observe: (_fixture, result) => ({
    resolvedName: result.ok ? result.value.name : "",
    isTarget: result.ok && result.value.name === "target",
  }),
};

describe("workspace resolver", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(
  registerCleanup?: (cleanup: () => void) => void,
  options: { managedBinding?: boolean; rejectNamedWorkspace?: boolean } = {},
): { fixture: WorkspaceFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-workspace-resolver-"));
  const targetPath = join(root, "target");
  const nestedTargetPath = join(targetPath, "nested");
  const otherPath = join(root, "other");
  mkdirSync(nestedTargetPath, { recursive: true });
  mkdirSync(otherPath);
  const target = Workspace.create({
    id: workspaceIdForPath(realpathSafe(targetPath)),
    rootPath: realpathSafe(targetPath),
    name: "target",
    isGit: false,
  });
  const other = Workspace.create({
    id: workspaceIdForPath(realpathSafe(otherPath)),
    rootPath: realpathSafe(otherPath),
    name: "other",
    isGit: false,
  });
  const records = [target, other];
  const workspaces: WorkspaceRepository = {
    findById: (id) => Effect.succeed(records.find((workspace) => workspace.id === id)),
    list: () => Effect.succeed([...records]),
    insert: () => Effect.succeed(true),
    upsert: () => Effect.succeed(undefined),
    delete: () => Effect.succeed(undefined),
  };
  const resolver = new WorkspaceResolverAdapter({
    cwd: otherPath,
    environment: options.managedBinding ? { MUXIMOD_WORKSPACE_ID: target.id } : {},
    workspaces,
    ...(options.managedBinding || options.rejectNamedWorkspace
      ? {
          directory: {
            resolveDirectory: (directory: string) => {
              if (options.rejectNamedWorkspace && directory === realpathSafe(targetPath)) {
                return Effect.fail(new Error("workspace root is outside the allowed roots"));
              }
              return Effect.fail(new Error("caller cwd should not be resolved"));
            },
            resolveHook: () => Effect.succeed(""),
          },
        }
      : {}),
  });
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  return { fixture: { root, targetPath, nestedTargetPath, otherPath, resolver } };
}

function createManagedFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorkspaceFixture } {
  return createFixture(registerCleanup, { managedBinding: true });
}

function createNamedBoundaryFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorkspaceFixture } {
  return createFixture(registerCleanup, { rejectNamedWorkspace: true });
}
