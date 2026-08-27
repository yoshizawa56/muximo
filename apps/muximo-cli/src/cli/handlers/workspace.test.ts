import type { RegisterWorkspaceRequest, UpdateWorkspaceRequest, WorkspaceDirectory } from "@muximo/contract/api";
import {
  type Assertion,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type {
  CliIo,
  CliWorkspaceAddInput,
  CliWorkspaceDeleteInput,
  CliWorkspaceListInput,
  CliWorkspaceUpdateInput,
} from "../commands/types.js";
import { createWorkspaceHandlers } from "./workspace.js";

type WorkspaceInput =
  | { kind: "list"; input: CliWorkspaceListInput }
  | { kind: "add"; input: CliWorkspaceAddInput }
  | { kind: "update"; input: CliWorkspaceUpdateInput }
  | { kind: "delete"; input: CliWorkspaceDeleteInput };

type WorkspaceFixture = {
  workspace: WorkspaceDirectory;
  out: string[];
  calls: string[];
  added?: RegisterWorkspaceRequest;
  updated?: { selector: string; input: UpdateWorkspaceRequest };
  deleted?: string;
  handlers: ReturnType<typeof createWorkspaceHandlers>;
};

type WorkspaceResult = { status: number; out: string; calls: readonly string[] };

const contains = (name: string, value: string): Assertion<WorkspaceResult, WorkspaceResult> => ({
  name,
  check: (context) => expect(context.out).toContain(value),
});

const cases = [
  {
    name: "maps workspace add flags into a typed application input",
    input: {
      kind: "add",
      input: {
        directory: "/workspace",
        name: "review",
        nameExplicit: true,
        setupHook: null,
        setupHookExplicit: true,
        cleanupHook: "cleanup.sh",
        cleanupHookExplicit: true,
        copyPatterns: [".env"],
        copyPatternsExplicit: true,
        appendCopyPatterns: [],
        clearCopyPatterns: false,
      },
    },
    assert: [
      contains("presents the add result", "workspace 'workspace' added"),
      {
        name: "uses clearPatch for an explicitly cleared hook",
        check: (context) => expect(context.calls).toContain("add-clear-hook"),
      },
    ],
  },
  {
    name: "maps workspace update flags and preserves presentation",
    input: {
      kind: "update",
      input: {
        selector: "workspace",
        name: undefined,
        nameExplicit: false,
        setupHook: undefined,
        setupHookExplicit: false,
        cleanupHook: undefined,
        cleanupHookExplicit: false,
        copyPatterns: [],
        copyPatternsExplicit: false,
        appendCopyPatterns: [".env.local"],
        clearCopyPatterns: true,
      },
    },
    assert: [
      contains("presents the update result", "workspace 'workspace' updated"),
      {
        name: "passes append and clear copy policy",
        check: (context) => expect(context.calls).toContain("update-copy-policy"),
      },
    ],
  },
  {
    name: "presents workspace list output from typed records",
    input: { kind: "list", input: { json: true } },
    assert: [contains("presents JSON workspace output", '"name":"workspace"')],
  },
  {
    name: "presents unregister without deleting the directory",
    input: { kind: "delete", input: { selector: "workspace" } },
    assert: [contains("presents the unregister result", "directory was not deleted")],
  },
] satisfies readonly OperationCase<"default", WorkspaceInput, WorkspaceResult, WorkspaceResult>[];

const table: OperationTable<WorkspaceFixture, "default", WorkspaceInput, WorkspaceResult, WorkspaceResult> = {
  defaultFixture: () => ({ fixture: createFixture() }),
  cases,
  execute: async (fixture, input) => {
    const status =
      input.kind === "list"
        ? await fixture.handlers.workspaceList(input.input)
        : input.kind === "add"
          ? await fixture.handlers.workspaceAdd(input.input)
          : input.kind === "update"
            ? await fixture.handlers.workspaceUpdate(input.input)
            : await fixture.handlers.workspaceDelete(input.input);
    return { status, out: fixture.out.join(""), calls: [...fixture.calls] };
  },
  observe: (fixture, result) => ({
    status: result.ok ? result.value.status : -1,
    out: fixture.out.join(""),
    calls: [...fixture.calls],
  }),
};

function createFixture(): WorkspaceFixture {
  const workspace: WorkspaceDirectory = {
    id: "workspace-id",
    directory: "/workspace",
    name: "workspace",
    isGit: true,
    setupScriptPath: null,
    cleanupScriptPath: null,
    worktreeCopyPatterns: [".env"],
  };
  const out: string[] = [];
  const calls: string[] = [];
  const fixture = {
    workspace,
    out,
    calls,
    handlers: undefined as unknown as ReturnType<typeof createWorkspaceHandlers>,
  };
  const io = {
    out: { write: (value: string) => out.push(value) },
    err: { write: () => undefined },
  } as unknown as CliIo;
  fixture.handlers = createWorkspaceHandlers({
    list: { execute: async () => [workspace] },
    add: {
      execute: async (input) => {
        if (input.setupScriptPath === null) calls.push("add-clear-hook");
        return workspace;
      },
    },
    update: {
      execute: async (selector, input) => {
        if (
          selector === "workspace" &&
          input.appendWorktreeCopyPatterns?.[0] === ".env.local" &&
          input.clearWorktreeCopyPatterns
        ) {
          calls.push("update-copy-policy");
        }
        return workspace;
      },
    },
    delete: {
      execute: async (selector) => {
        calls.push(`delete:${selector}`);
        return workspace;
      },
    },
    io,
  });
  return fixture;
}

describe("typed workspace CLI handlers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
