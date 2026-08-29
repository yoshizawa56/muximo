import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceRepository, WorkspaceResolutionInput } from "@muximo/application";
import { Workspace, type WorkspaceRecord } from "@muximo/domain";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
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
type ResolverResult = WorkspaceRecord;
type ResolverContext = {
  resolvedName: string;
  isTarget: boolean;
};
type FixtureKey = "default" | "managed";

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
    name: "does not accept an internal workspace id as a selector",
    input: { workspace: "workspace-id" },
    assert: [hasError<ResolverContext, ResolverResult>({ message: /workspace not found/iu })],
  },
] satisfies readonly OperationCase<FixtureKey, ResolverInput, ResolverResult, ResolverContext>[];

const table: OperationTable<WorkspaceFixture, FixtureKey, ResolverInput, ResolverResult, ResolverContext> = {
  defaultFixture: createFixture,
  fixtures: { default: createFixture, managed: createManagedFixture },
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
  options: { managedBinding?: boolean } = {},
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
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  });
  const other = Workspace.create({
    id: workspaceIdForPath(realpathSafe(otherPath)),
    rootPath: realpathSafe(otherPath),
    name: "other",
    isGit: false,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  });
  const records = [target, other];
  const workspaces: WorkspaceRepository = {
    findById: async (id) => records.find((workspace) => workspace.id === id),
    list: async () => [...records],
    insert: async () => true,
    upsert: async () => undefined,
    delete: async () => undefined,
  };
  const resolver = new WorkspaceResolverAdapter({
    cwd: otherPath,
    environment: options.managedBinding ? { MUXIMOD_WORKSPACE_ID: target.id } : {},
    workspaces,
    ...(options.managedBinding
      ? {
          directory: {
            resolveDirectory: () => {
              throw new Error("caller cwd should not be resolved");
            },
            resolveHook: () => "",
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
