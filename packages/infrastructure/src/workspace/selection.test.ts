// Tests for workspace discovery stay co-located with its adapter.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  type Assertion,
  type FixtureHandle,
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  resolveMaybePromise,
  returns,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AllowedRootPolicy, allowedRootsFromEnvironment, WorkspaceSelectionCatalog } from "./selection.js";

type EmptyContext = {};
type RootsInput = { env: NodeJS.ProcessEnv; fallback?: string };
const rootsCases = [
  {
    name: "reads the documented workspace roots variable",
    input: { env: { MUXIMOD_WORKSPACE_ROOTS: "/work:/projects" }, fallback: "/muximod" },
    assert: [returns<EmptyContext, string[]>(["/work", "/projects"])],
  },
  {
    name: "uses the supplied fallback root",
    input: { env: {}, fallback: "/muximod" },
    assert: [returns<EmptyContext, string[]>(["/muximod"])],
  },
  {
    name: "falls back to the effective home directory",
    input: { env: { HOME: "/home/test" } },
    assert: [returns<EmptyContext, string[]>(["/home/test"])],
  },
] satisfies readonly OperationCase<"default", RootsInput, string[], EmptyContext>[];

const rootsTable: OperationTable<undefined, "default", RootsInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: rootsCases,
  execute: (_fixture, input) => allowedRootsFromEnvironment(input.env, input.fallback),
  observe: () => ({}),
};

type PolicyFixture = {
  root: string;
  outside: string;
  file: string;
  policy: AllowedRootPolicy;
  actualPath: string | null;
  expectedPath: string | null;
};
type PolicyInput = { candidate: "root" | "child" | "outside" | "missing" | "file" };
const policyFixture = (): FixtureHandle<PolicyFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-policy-"));
  const outside = mkdtempSync(join(tmpdir(), "muximo-outside-"));
  const child = join(root, "project");
  mkdirSync(child);
  const file = join(root, "README");
  writeFileSync(file, "fixture\n");
  return {
    fixture: { root, outside, file, policy: new AllowedRootPolicy([root]), actualPath: null, expectedPath: null },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
};

const policyCases = [
  { name: "accepts the configured root", input: { candidate: "root" }, assert: [hasResolvedPath()] },
  { name: "accepts a directory below the configured root", input: { candidate: "child" }, assert: [hasResolvedPath()] },
  {
    name: "rejects a path outside the configured root",
    input: { candidate: "outside" },
    assert: [hasError<PolicyContext, string>({ code: "invalid_directory", reason: "outside_allowed_root" })],
  },
  {
    name: "rejects a missing directory",
    input: { candidate: "missing" },
    assert: [hasError<PolicyContext, string>({ code: "invalid_directory", reason: "not_found" })],
  },
  {
    name: "rejects a regular file",
    input: { candidate: "file" },
    assert: [hasError<PolicyContext, string>({ code: "invalid_directory", reason: "not_directory" })],
  },
] satisfies readonly OperationCase<"default", PolicyInput, string, PolicyContext>[];

type PolicyContext = { actualPath: string | null; expectedPath: string | null };
function hasResolvedPath(): Assertion<PolicyContext, string> {
  return {
    name: "resolves to the canonical directory path",
    check: (ctx, result) => {
      if (!result.ok) throw result.error;
      expect(result.value).toBe(ctx.expectedPath);
    },
  };
}

const policyTable: OperationTable<PolicyFixture, "default", PolicyInput, string, PolicyContext> = {
  defaultFixture: policyFixture,
  cases: policyCases,
  execute: (fixture, input) => {
    const candidate =
      input.candidate === "root"
        ? fixture.root
        : input.candidate === "child"
          ? join(fixture.root, "project")
          : input.candidate === "outside"
            ? fixture.outside
            : input.candidate === "file"
              ? fixture.file
              : join(fixture.root, "missing");
    fixture.expectedPath = input.candidate === "root" || input.candidate === "child" ? realpathSync(candidate) : null;
    fixture.actualPath = fixture.policy.assertDirectory(candidate);
    return fixture.actualPath;
  },
  observe: (fixture) => ({ actualPath: fixture.actualPath, expectedPath: fixture.expectedPath }),
};

type CatalogFixture = {
  root: string;
  repository: string;
  setup: string;
  catalog: WorkspaceSelectionCatalog;
  registered?: Workspace;
  browseGit: boolean;
  resolvedId: string | null;
};
type CatalogStep =
  | { type: "browse" }
  | { type: "register" }
  | { type: "resolve" }
  | { type: "resolve-missing" }
  | { type: "invalid-hook" };
type CatalogContext = { browseGit: boolean; resolvedId: string | null };

const catalogFixture = (): FixtureHandle<CatalogFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-catalog-"));
  const repository = join(root, "muximo");
  mkdirSync(repository);
  execFileSync("git", ["init", "-q", repository]);
  mkdirSync(join(root, "scratch"));
  const setup = join(root, "setup");
  writeFileSync(setup, "#!/bin/sh\n");
  chmodSync(setup, 0o755);
  return {
    fixture: {
      root,
      repository,
      setup,
      catalog: new WorkspaceSelectionCatalog([root]),
      browseGit: false,
      resolvedId: null,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const catalogCases = [
  {
    name: "browses directories, registers a workspace, and resolves a worktree",
    steps: [{ type: "browse" }, { type: "register" }, { type: "resolve" }],
    assert: [
      hasObserved<CatalogContext, undefined>("browseGit", true),
      hasObserved<CatalogContext, undefined>("resolvedId", "registered"),
    ],
  },
  {
    name: "rejects an unknown registered workspace id",
    steps: [{ type: "resolve-missing" }],
    assert: [hasError<CatalogContext, undefined>({ code: "invalid_directory", reason: "unknown_workspace" })],
  },
  {
    name: "rejects a non-executable hook during registration",
    steps: [{ type: "invalid-hook" }],
    assert: [hasError<CatalogContext, undefined>({ code: "invalid_hook", reason: "not_executable" })],
  },
] satisfies readonly ScenarioCase<"default", CatalogStep, undefined, CatalogContext>[];

const catalogTable: ScenarioTable<CatalogFixture, "default", CatalogStep, undefined, CatalogContext> = {
  defaultFixture: catalogFixture,
  cases: catalogCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "browse") {
        const workspaces = await resolveMaybePromise(fixture.catalog.browseDirectories(fixture.root));
        fixture.browseGit = workspaces.some((workspace) => workspace.name === "muximo" && workspace.isGit);
      }
      if (step.type === "register") {
        const resolved = await resolveMaybePromise(fixture.catalog.resolveDirectory(fixture.repository));
        fixture.registered = Workspace.create({
          ...resolved,
          setupScriptPath: await resolveMaybePromise(fixture.catalog.resolveHook(fixture.setup, resolved.rootPath)),
        });
      }
      if (step.type === "resolve") {
        const registered = fixture.registered!;
        const resolved = await resolveMaybePromise(
          fixture.catalog.resolveSelection({ workspaceId: registered.id, mode: "worktree" }, () =>
            Effect.succeed(registered),
          ),
        );
        fixture.resolvedId = resolved.id === registered.id ? "registered" : resolved.id;
      }
      if (step.type === "resolve-missing")
        await resolveMaybePromise(
          fixture.catalog.resolveSelection({ workspaceId: WorkspaceId.create("missing"), mode: "workspace" }, () =>
            Effect.succeed(undefined),
          ),
        );
      if (step.type === "invalid-hook") {
        const hook = join(fixture.root, "not-executable");
        writeFileSync(hook, "#!/bin/sh\n");
        const resolved = await resolveMaybePromise(fixture.catalog.resolveDirectory(fixture.repository));
        const record = Workspace.create({
          ...resolved,
          setupScriptPath: hook,
        });
        await resolveMaybePromise(fixture.catalog.resolveWorkspaceDirectory(record.id, () => Effect.succeed(record)));
      }
    }
  },
  observe: (fixture) => ({ browseGit: fixture.browseGit, resolvedId: fixture.resolvedId }),
};

describe("workspace selection", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, rootsTable);
  runOperationTable(register, policyTable);
  runScenarioTable(register, catalogTable);
});
