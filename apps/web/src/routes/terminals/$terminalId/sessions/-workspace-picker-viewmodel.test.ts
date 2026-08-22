import {
  type Assertion,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { WorkspacePickerInput, WorkspacePickerState } from "./-workspace-picker-viewmodel";
import { workspacePickerErrorMessage, workspacePickerState } from "./-workspace-picker-viewmodel";

const workspaces = [
  {
    id: "workspace-1",
    name: "muximo",
    directory: "~/work/muximo",
    isGit: true,
    setupScriptPath: null,
    cleanupScriptPath: null,
    worktreeCopyPatterns: [],
  },
  {
    id: "workspace-2",
    name: "scratch",
    directory: "~/tmp/scratch",
    isGit: false,
    setupScriptPath: null,
    cleanupScriptPath: null,
    worktreeCopyPatterns: [],
  },
];

const baseInput: Omit<WorkspacePickerInput, "workspaces" | "workspaceId" | "mode" | "workspaceStatus"> = {
  workspaceCandidates: [],
  browserStatus: "ready",
  browserPath: null,
  registrationOpen: false,
  registrationDirectory: "",
  setupScriptPath: "",
  cleanupScriptPath: "",
  worktreeCopyPatterns: "",
  isRegisteringWorkspace: false,
  registrationError: null,
  errorMessage: null,
};

type PickerAssertion = Assertion<{}, WorkspacePickerState>;
const hasPickerState = (expected: { canContinue: boolean; selectedWorkspaceId: string | null }): PickerAssertion => ({
  name: "returns the picker decision",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.canContinue).toBe(expected.canContinue);
    expect(result.value.selectedWorkspace?.id ?? null).toBe(expected.selectedWorkspaceId);
  },
});

const pickerCases = [
  {
    name: "waits for directories while loading",
    input: { ...baseInput, workspaces: [], workspaceId: "", mode: "workspace", workspaceStatus: "loading" },
    assert: [hasPickerState({ canContinue: false, selectedWorkspaceId: null })],
  },
  {
    name: "allows a selected regular workspace",
    input: { ...baseInput, workspaces, workspaceId: "workspace-2", mode: "workspace", workspaceStatus: "ready" },
    assert: [hasPickerState({ canContinue: true, selectedWorkspaceId: "workspace-2" })],
  },
  {
    name: "allows a selected workspace worktree",
    input: { ...baseInput, workspaces, workspaceId: "workspace-1", mode: "worktree", workspaceStatus: "ready" },
    assert: [hasPickerState({ canContinue: true, selectedWorkspaceId: "workspace-1" })],
  },
  {
    name: "disables worktree mode for a non-git directory",
    input: { ...baseInput, workspaces, workspaceId: "workspace-2", mode: "worktree", workspaceStatus: "ready" },
    assert: [hasPickerState({ canContinue: false, selectedWorkspaceId: "workspace-2" })],
  },
  {
    name: "does not allow a stale workspace id",
    input: { ...baseInput, workspaces, workspaceId: "missing", mode: "workspace", workspaceStatus: "ready" },
    assert: [hasPickerState({ canContinue: false, selectedWorkspaceId: null })],
  },
] satisfies readonly OperationCase<"default", WorkspacePickerInput, WorkspacePickerState, {}>[];

const pickerTable: OperationTable<undefined, "default", WorkspacePickerInput, WorkspacePickerState, {}> = {
  defaultFixture: noFixture(),
  cases: pickerCases,
  execute: (_fixture, input) => workspacePickerState(input),
  observe: () => ({}),
};

type ErrorInput = { value: unknown };
const errorCases = [
  {
    name: "formats Error instances",
    input: { value: new Error("workspace service unavailable") },
    assert: [returns<{}, string | null>("workspace service unavailable")],
  },
  {
    name: "formats error-like objects",
    input: { value: { message: "Directory is outside the allowed workspace roots" } },
    assert: [returns<{}, string | null>("Directory is outside the allowed workspace roots")],
  },
  { name: "ignores null errors", input: { value: null }, assert: [returns<{}, string | null>(null)] },
] satisfies readonly OperationCase<"default", ErrorInput, string | null, {}>[];

const errorTable: OperationTable<undefined, "default", ErrorInput, string | null, {}> = {
  defaultFixture: noFixture(),
  cases: errorCases,
  execute: (_fixture, input) => workspacePickerErrorMessage(input.value),
  observe: () => ({}),
};

describe("workspace picker viewmodel", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, pickerTable);
  runOperationTable(register, errorTable);
});
