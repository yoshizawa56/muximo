import {
  InvalidAgentSessionNameError,
  InvalidEntityError,
  InvalidWorkspaceNameError,
  WorkspaceId,
  WorkspaceSelectionError,
  WorkspaceUpdateEmptyError,
} from "@muximo/domain";
import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { ApplicationError, ApplicationFailure } from "./ports/application.js";
import { DaemonHealthError } from "./ports/daemon.js";
import { controlFailure } from "./usecases/agents/control-failure.js";

type EmptyContext = {};

type FailureProbe =
  | { kind: "control" }
  | { kind: "daemon" }
  | { kind: "application" }
  | { kind: "application-failure"; reason: "session_not_found" | "abandoned_cleanup_failed" }
  | { kind: "invalid-entity" }
  | { kind: "invalid-workspace-name" }
  | { kind: "workspace-update-empty" }
  | { kind: "workspace-selection" }
  | { kind: "invalid-agent-name" };

type FailureObservation = {
  tag: unknown;
  name: unknown;
  code: unknown;
  message: unknown;
};

function probe(input: FailureProbe): FailureObservation {
  const error = makeError(input);
  return {
    tag: (error as { _tag?: unknown })._tag,
    name: error.name,
    code: (error as { code?: unknown }).code,
    message: error.message,
  };
}

function makeError(input: FailureProbe): Error {
  switch (input.kind) {
    case "control":
      return controlFailure("agent_session_not_found", "agent session not found: session-1");
    case "daemon":
      return new DaemonHealthError("startup_timeout", { logFile: "/tmp/muximod.log" }, { startedAt: 0 });
    case "application":
      return new ApplicationError("pane_not_visible", "terminal host created the pane but it could not be read");
    case "application-failure":
      return new ApplicationFailure(
        input.reason,
        input.reason === "session_not_found"
          ? "session not found: ref"
          : "abandoned session 's' could not be cleaned up",
      );
    case "invalid-entity":
      return new InvalidEntityError("Workspace");
    case "invalid-workspace-name":
      return new InvalidWorkspaceNameError("");
    case "workspace-update-empty":
      return new WorkspaceUpdateEmptyError();
    case "workspace-selection":
      return new WorkspaceSelectionError("workspace_not_found", "Workspace directory not found: w", {
        workspaceId: WorkspaceId.create("workspace-1"),
      });
    case "invalid-agent-name":
      return new InvalidAgentSessionNameError();
  }
}

const failureCases = [
  {
    name: "tags control-channel failures without changing their shape",
    input: { kind: "control" },
    assert: [
      returns<EmptyContext, FailureObservation>({
        tag: "ControlFailure",
        name: "ControlFailure",
        code: "agent_session_not_found",
        message: "agent session not found: session-1",
      }),
    ],
  },
  {
    name: "tags daemon health failures",
    input: { kind: "daemon" },
    assert: [
      returns<EmptyContext, FailureObservation>({
        tag: "DaemonHealthError",
        name: "DaemonHealthError",
        code: undefined,
        message: "startup_timeout",
      }),
    ],
  },
  {
    name: "tags application failures",
    input: { kind: "application" },
    assert: [
      returns<EmptyContext, FailureObservation>({
        tag: "ApplicationError",
        name: "ApplicationError",
        code: "pane_not_visible",
        message: "terminal host created the pane but it could not be read",
      }),
    ],
  },
  {
    name: "tags uncoded application failures while keeping them codeless for the wire",
    input: { kind: "application-failure", reason: "session_not_found" },
    assert: [
      returns<EmptyContext, FailureObservation>({
        tag: "ApplicationFailure",
        name: "ApplicationFailure",
        code: undefined,
        message: "session not found: ref",
      }),
    ],
  },
  {
    name: "tags entity validation failures",
    input: { kind: "invalid-entity" },
    assert: [
      returns<EmptyContext, FailureObservation>({
        tag: "InvalidEntityError",
        name: "InvalidEntityError",
        code: "invalid_entity",
        message: "Workspace data failed validation",
      }),
    ],
  },
  {
    name: "tags workspace name failures",
    input: { kind: "invalid-workspace-name" },
    assert: [
      hasError<EmptyContext, FailureObservation>({ code: "invalid_workspace_name", _tag: "InvalidWorkspaceNameError" }),
    ],
  },
  {
    name: "tags empty workspace updates",
    input: { kind: "workspace-update-empty" },
    assert: [
      hasError<EmptyContext, FailureObservation>({ code: "workspace_update_empty", _tag: "WorkspaceUpdateEmptyError" }),
    ],
  },
  {
    name: "tags workspace selection failures",
    input: { kind: "workspace-selection" },
    assert: [
      hasError<EmptyContext, FailureObservation>({ code: "workspace_not_found", _tag: "WorkspaceSelectionError" }),
    ],
  },
  {
    name: "tags agent session name failures",
    input: { kind: "invalid-agent-name" },
    assert: [
      hasError<EmptyContext, FailureObservation>({ code: "invalid_agent_name", _tag: "InvalidAgentSessionNameError" }),
    ],
  },
] satisfies readonly OperationCase<"default", FailureProbe, FailureObservation, EmptyContext>[];

const failureTable: OperationTable<undefined, "default", FailureProbe, FailureObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: failureCases,
  execute: (_fixture, input) => {
    if (
      input.kind === "invalid-workspace-name" ||
      input.kind === "workspace-update-empty" ||
      input.kind === "workspace-selection" ||
      input.kind === "invalid-agent-name"
    ) {
      throw makeError(input);
    }
    return probe(input);
  },
  observe: () => ({}),
};

describe("failure taxonomy", () => {
  runOperationTable(it as unknown as TestRegistrar, failureTable);
});
