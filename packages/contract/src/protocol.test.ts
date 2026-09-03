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
import { encodePairingCode } from "./auth-crypto.js";
import {
  clientControlMessageSchema,
  createPaneRequestSchema,
  createSessionRequestSchema,
  decodeClientControlFrame,
  decodeServerControlFrame,
  encodeClientControlFrame,
  encodeServerControlFrame,
  manageSessionRequestSchema,
  maxPasteImageBase64Length,
  muximodCapabilitiesSchema,
  muximodControlRequestSchema,
  muximodControlResponseSchema,
  muximodEventSchema,
  muximodHealthSchema,
  operationAcceptedResponseSchema,
  operationStatusSchema,
  paneListResponseSchema,
  serverControlMessageSchema,
  terminalProtocolVersion,
  workspaceSelectionSchema,
} from "./protocol.js";

type EmptyContext = {};
type ValidationResult = { success: boolean; data?: unknown; issuePath?: readonly (string | number)[] };
type ValidationSchema = { safeParse: (input: unknown) => unknown };

const isValid = (expectedData?: unknown): Assertion<EmptyContext, ValidationResult> => ({
  name: "accepts the input",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.success).toBe(true);
    if (expectedData !== undefined) expect(result.value.data).toEqual(expectedData);
  },
});

const isInvalid = (expectedPath?: readonly (string | number)[]): Assertion<EmptyContext, ValidationResult> => ({
  name: "rejects the input",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.success).toBe(false);
    if (expectedPath) expect(result.value.issuePath).toEqual(expectedPath);
  },
});

const createValidationTable = (
  cases: readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[],
  schema: ValidationSchema,
): OperationTable<undefined, "default", unknown, ValidationResult, EmptyContext> => ({
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => parseSchema(schema, input),
  observe: () => ({}),
});

function parseSchema(schema: ValidationSchema, input: unknown): ValidationResult {
  const parsed = schema.safeParse(input) as {
    success?: boolean;
    data?: unknown;
    error?: { issues?: readonly { path?: readonly PropertyKey[] }[] };
  };
  if (parsed.success) return { success: true, data: parsed.data };
  const path = parsed.error?.issues?.[0]?.path?.map((segment) =>
    typeof segment === "symbol" ? segment.toString() : segment,
  );
  return { success: false, issuePath: path };
}

const clientCases = [
  {
    name: "accepts an attach request",
    input: { type: "attach", version: terminalProtocolVersion, target: "muximod", cols: 80, rows: 24 },
    assert: [isValid({ type: "attach", version: terminalProtocolVersion, target: "muximod", cols: 80, rows: 24 })],
  },
  {
    name: "accepts a mobile claim request",
    input: { type: "claim", version: terminalProtocolVersion, cols: 80, rows: 24 },
    assert: [isValid({ type: "claim", version: terminalProtocolVersion, cols: 80, rows: 24 })],
  },
  {
    name: "accepts an authoritative redraw request",
    input: { type: "redraw", version: terminalProtocolVersion },
    assert: [isValid({ type: "redraw", version: terminalProtocolVersion })],
  },
  {
    name: "accepts a terminal heartbeat",
    input: { type: "ping", version: terminalProtocolVersion, nonce: "heartbeat-1" },
    assert: [isValid({ type: "ping", version: terminalProtocolVersion, nonce: "heartbeat-1" })],
  },
  {
    name: "accepts a request to enter tmux copy mode",
    input: { type: "enter_copy_mode", version: terminalProtocolVersion },
    assert: [isValid({ type: "enter_copy_mode", version: terminalProtocolVersion })],
  },
  {
    name: "accepts a request to paste the tmux buffer",
    input: { type: "paste_tmux_buffer", version: terminalProtocolVersion },
    assert: [isValid({ type: "paste_tmux_buffer", version: terminalProtocolVersion })],
  },
  {
    name: "rejects an invalid terminal size",
    input: { type: "resize", version: terminalProtocolVersion, cols: 0, rows: 24 },
    assert: [isInvalid(["cols"])],
  },
  {
    name: "accepts a resumed attach with paired credentials",
    input: {
      type: "attach",
      version: terminalProtocolVersion,
      target: "%3",
      cols: 80,
      rows: 24,
      sessionId: "terminal-1",
      resumeToken: "resume-token",
    },
    assert: [
      isValid({
        type: "attach",
        version: terminalProtocolVersion,
        target: "%3",
        cols: 80,
        rows: 24,
        sessionId: "terminal-1",
        resumeToken: "resume-token",
      }),
    ],
  },
  {
    name: "rejects an attach with only one resume credential",
    input: {
      type: "attach",
      version: terminalProtocolVersion,
      target: "%3",
      cols: 80,
      rows: 24,
      sessionId: "terminal-1",
    },
    assert: [isInvalid()],
  },
  {
    name: "accepts an image paste request",
    input: {
      type: "paste_image",
      version: terminalProtocolVersion,
      name: "screenshot.png",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    },
    assert: [
      isValid({
        type: "paste_image",
        version: terminalProtocolVersion,
        name: "screenshot.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      }),
    ],
  },
  {
    name: "accepts an image paste without a mime type",
    input: { type: "paste_image", version: terminalProtocolVersion, name: "photo", data: "AAEC" },
    assert: [isValid()],
  },
  {
    name: "rejects an image paste with an empty payload",
    input: { type: "paste_image", version: terminalProtocolVersion, name: "photo.png", data: "" },
    assert: [isInvalid(["data"])],
  },
  {
    name: "rejects an image paste with a non-base64 payload",
    input: { type: "paste_image", version: terminalProtocolVersion, name: "photo.png", data: "not base64!" },
    assert: [isInvalid(["data"])],
  },
  {
    name: "rejects an image paste with a control character in the name",
    input: { type: "paste_image", version: terminalProtocolVersion, name: "photo\n.png", data: "AAEC" },
    assert: [isInvalid(["name"])],
  },
  {
    name: "rejects an image paste with a colon in the name",
    input: { type: "paste_image", version: terminalProtocolVersion, name: "photo:1.png", data: "AAEC" },
    assert: [isInvalid(["name"])],
  },
  {
    name: "rejects an oversized image paste",
    input: {
      type: "paste_image",
      version: terminalProtocolVersion,
      name: "big.png",
      data: "A".repeat(maxPasteImageBase64Length + 1),
    },
    assert: [isInvalid(["data"])],
  },
  {
    name: "rejects an attach request with an unknown field",
    input: {
      type: "attach",
      version: terminalProtocolVersion,
      target: "muximod",
      cols: 80,
      rows: 24,
      legacyTarget: "muximod",
    },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const serverCases = [
  {
    name: "describes the mobile viewport after attach",
    input: {
      type: "ready",
      version: terminalProtocolVersion,
      sessionId: "terminal-1",
      resumeToken: "resume-token",
      resumed: false,
      target: "project:0.1",
      paneId: "%3",
      windowId: "@1",
      owner: "mobile",
      sync: "live",
      cols: 80,
      rows: 24,
    },
    assert: [isValid()],
  },
  {
    name: "describes a desktop takeover",
    input: { type: "viewport", version: terminalProtocolVersion, owner: "desktop", reason: "desktop_activity" },
    assert: [isValid()],
  },
  {
    name: "describes a terminal heartbeat response",
    input: { type: "pong", version: terminalProtocolVersion, nonce: "heartbeat-1" },
    assert: [isValid()],
  },
  {
    name: "requires a lifecycle reason on a closed frame",
    input: {
      type: "closed",
      version: terminalProtocolVersion,
      sessionId: "terminal-1",
      reason: "detached",
      code: null,
      signal: null,
    },
    assert: [isValid()],
  },
  {
    name: "rejects a viewport frame with an unknown field",
    input: {
      type: "viewport",
      version: terminalProtocolVersion,
      owner: "desktop",
      reason: "desktop_activity",
      legacyOwner: "desktop",
    },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const operationStatus = {
  operationId: "operation-id-123456",
  kind: "agent_session.cleanup",
  state: "failed",
  createdAt: "2026-08-30T00:00:00.000Z",
  startedAt: "2026-08-30T00:00:01.000Z",
  completedAt: "2026-08-30T00:00:02.000Z",
  updatedAt: "2026-08-30T00:00:02.000Z",
  result: { cleanup: { disposition: "failed", reason: "cleanup_hook_failed" } },
  error: {
    code: "agent_cleanup_failed",
    message: "agent session cleanup failed",
    details: { retryable: false },
  },
  diagnostic: "cleanup hook output is available",
  logReference: "/tmp/muximo-cleanup.log",
  cancelRequestedAt: "2026-08-30T00:00:01.500Z",
} as const;

const operationStatusCases = [
  {
    name: "accepts a terminal operation status with result and structured failure",
    input: operationStatus,
    assert: [isValid(operationStatus)],
  },
  {
    name: "rejects an operation status with an unsupported state",
    input: { ...operationStatus, state: "pending" },
    assert: [isInvalid(["state"])],
  },
  {
    name: "rejects an operation error with an unknown field",
    input: { ...operationStatus, error: { ...operationStatus.error, retryable: false } },
    assert: [isInvalid(["error"])],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const operationAcceptedCases = [
  {
    name: "accepts an operation accepted response",
    input: { operation: operationStatus },
    assert: [isValid({ operation: operationStatus })],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const operationStatusTable: OperationTable<undefined, "default", unknown, ValidationResult, EmptyContext> =
  createValidationTable(operationStatusCases, operationStatusSchema);
const operationAcceptedTable: OperationTable<undefined, "default", unknown, ValidationResult, EmptyContext> =
  createValidationTable(operationAcceptedCases, operationAcceptedResponseSchema);

const eventCases = [
  {
    name: "accepts a pane creation invalidation",
    input: { type: "session_updated", sessionName: "muximod", reason: "pane_created", revision: 1 },
    assert: [isValid()],
  },
  {
    name: "rejects an event without a session scope",
    input: { type: "session_updated", reason: "pane_deleted", revision: 2 },
    assert: [isInvalid()],
  },
  {
    name: "rejects an event with an unknown field",
    input: { type: "session_updated", sessionName: "muximod", reason: "pane_changed", revision: 3, oldRevision: 2 },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const healthCases = [
  {
    name: "accepts the current health contract",
    input: {
      ok: true,
      service: "muximod",
      protocolVersion: terminalProtocolVersion,
      pid: 1234,
      configurationFingerprint: "0".repeat(64),
    },
    assert: [isValid()],
  },
  {
    name: "rejects a health response for an unsupported protocol version",
    input: {
      ok: true,
      service: "muximod",
      protocolVersion: 99,
      pid: 1234,
      configurationFingerprint: "0".repeat(64),
    },
    assert: [isInvalid(["protocolVersion"])],
  },
  {
    name: "rejects a health response with an unknown field",
    input: {
      ok: true,
      service: "muximod",
      protocolVersion: terminalProtocolVersion,
      pid: 1234,
      configurationFingerprint: "0".repeat(64),
      legacy: true,
    },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const capabilitiesCases = [
  {
    name: "accepts the current capabilities contract",
    input: {
      protocolVersion: terminalProtocolVersion,
      features: {
        tmuxSessions: true,
        terminalWebSocket: true,
        paneState: true,
        resourceInvalidationEvents: true,
      },
    },
    assert: [isValid()],
  },
  {
    name: "rejects capabilities for an unsupported protocol version",
    input: {
      protocolVersion: 99,
      features: {
        tmuxSessions: true,
        terminalWebSocket: true,
        paneState: true,
        resourceInvalidationEvents: true,
      },
    },
    assert: [isInvalid(["protocolVersion"])],
  },
  {
    name: "rejects an unknown capability",
    input: {
      protocolVersion: terminalProtocolVersion,
      features: {
        tmuxSessions: true,
        terminalWebSocket: true,
        paneState: true,
        resourceInvalidationEvents: true,
        legacyFeature: true,
      },
    },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

type PairingInput = { kind: "request" | "response"; value: unknown };
const controlRequestId = "request-123456";
const pairingCases = [
  {
    name: "accepts a pairing request with a muximod endpoint",
    input: {
      kind: "request",
      value: { type: "create_pairing", requestId: controlRequestId, muximodBaseUrl: "https://muximod.example" },
    },
    assert: [isValid()],
  },
  {
    name: "rejects a pairing request with a non-http endpoint",
    input: {
      kind: "request",
      value: { type: "create_pairing", requestId: controlRequestId, muximodBaseUrl: "ftp://muximod.example" },
    },
    assert: [isInvalid(["muximodBaseUrl"])],
  },
  {
    name: "rejects a pairing request with endpoint credentials",
    input: {
      kind: "request",
      value: {
        type: "create_pairing",
        requestId: controlRequestId,
        muximodBaseUrl: "https://user:password@muximod.example",
      },
    },
    assert: [isInvalid(["muximodBaseUrl"])],
  },
  {
    name: "accepts a pairing response with a raw pairing code",
    input: {
      kind: "response",
      value: {
        type: "pairing_created",
        requestId: controlRequestId,
        pairingId: "pairing-1234567890123456",
        pairingCode: encodePairingCode({
          v: 2,
          muximodBaseUrl: "https://muximod.example",
          serverId: "server-1234567890123456",
          pairingId: "pairing-1234567890123456",
          pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-",
          expiresAt: 4_102_444_800_000,
        }),
        payload: {
          v: 2,
          muximodBaseUrl: "https://muximod.example",
          serverId: "server-1234567890123456",
          pairingId: "pairing-1234567890123456",
          pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-",
          expiresAt: 4_102_444_800_000,
        },
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts a pairing response",
    input: {
      kind: "response",
      value: {
        type: "pairing_result",
        requestId: controlRequestId,
        pairingId: "pairing-1234567890123456",
        status: "approved",
        deviceId: "device-1",
      },
    },
    assert: [isValid()],
  },
  {
    name: "rejects a pairing request without endpoint settings",
    input: { kind: "request", value: { type: "create_pairing" } },
    assert: [isInvalid()],
  },
  {
    name: "rejects an unrecognized control response",
    input: { kind: "response", value: { type: "unexpected" } },
    assert: [isInvalid()],
  },
  {
    name: "accepts an agent session adoption request",
    input: {
      kind: "request",
      value: {
        type: "adopt_agent_session",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent session release request",
    input: {
      kind: "request",
      value: {
        type: "release_agent_session",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts a provider observation request",
    input: {
      kind: "request",
      value: {
        type: "observe_agent_session",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
        state: "waiting_input",
        recentOutput: "recent output",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts a bounded daemon log request",
    input: {
      kind: "request",
      value: {
        type: "read_log",
        requestId: controlRequestId,
        lines: 100,
      },
    },
    assert: [isValid()],
  },
  {
    name: "rejects an unbounded daemon log request",
    input: {
      kind: "request",
      value: {
        type: "read_log",
        requestId: controlRequestId,
        lines: 10_001,
      },
    },
    assert: [isInvalid(["lines"])],
  },
  {
    name: "accepts an agent session adopted response",
    input: {
      kind: "response",
      value: {
        type: "agent_session_adopted",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent session released response",
    input: {
      kind: "response",
      value: {
        type: "agent_session_released",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts a provider observation response",
    input: {
      kind: "response",
      value: {
        type: "agent_session_observed",
        requestId: controlRequestId,
        agentSessionId: "session-id",
        hostPaneId: "%1",
        executionId: "execution-id-123456",
        state: "waiting_input",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts a daemon log response",
    input: {
      kind: "response",
      value: {
        type: "daemon_log",
        requestId: controlRequestId,
        state: "available",
        logFile: "/var/tmp/muximod.log",
        lines: ["muximod started"],
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent execution preparation request",
    input: {
      kind: "request",
      value: {
        type: "prepare_agent_execution",
        requestId: controlRequestId,
        operation: "run",
        input: {
          backend: "codex",
          hostPaneId: "%1",
          cwd: "/workspace/review",
          useWorktree: false,
          setupHookExplicit: false,
          cleanupHookExplicit: false,
          backendArgs: [],
        },
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent execution attach request",
    input: {
      kind: "request",
      value: {
        type: "attach_agent_execution",
        requestId: controlRequestId,
        operation: "run",
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        hostPaneId: "%1",
        executionPid: 4321,
        executionStartedAt: "2026-08-30T00:00:01.000Z",
      },
    },
    assert: [isValid()],
  },
  {
    name: "rejects a run preparation with resume input",
    input: {
      kind: "request",
      value: {
        type: "prepare_agent_execution",
        requestId: controlRequestId,
        operation: "run",
        input: {
          workspaceScope: "current",
          reference: "session",
          backendArgs: [],
        },
      },
    },
    assert: [isInvalid()],
  },
  {
    name: "accepts an agent execution completion request",
    input: {
      kind: "request",
      value: {
        type: "complete_agent_execution",
        requestId: controlRequestId,
        operation: "run",
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        hostPaneId: "%1",
        result: { started: true, code: 0, interrupted: false, signal: null, pid: 4321 },
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent execution preparation response",
    input: {
      kind: "response",
      value: {
        type: "agent_execution_prepared",
        requestId: controlRequestId,
        operation: "run",
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        hostPaneId: "%1",
        session: {
          id: "session-id",
          name: "review",
          backend: "codex",
          status: "running",
          workspaceId: "workspace-id",
          workspaceRoot: "/workspace/review",
          workspaceName: "workspace",
          useWorktree: false,
          setupRan: false,
          resuming: false,
          executionId: "execution-id-123456",
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
        execution: {
          sessionId: "session-id",
          executionId: "execution-id-123456",
          sessionName: "review",
          backend: "codex",
          cwd: "/workspace/review",
          command: ["codex", "--opaque"],
          environment: { MUXIMO_AGENT_SESSION_ID: "session-id" },
        },
      },
    },
    assert: [isValid()],
  },
  {
    name: "rejects an agent execution command without an executable",
    input: {
      kind: "response",
      value: {
        type: "agent_execution_prepared",
        requestId: controlRequestId,
        operation: "run",
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        session: {
          id: "session-id",
          name: "review",
          backend: "codex",
          status: "running",
          workspaceId: "workspace-id",
          workspaceRoot: "/workspace/review",
          workspaceName: "workspace",
          useWorktree: false,
          setupRan: false,
          resuming: false,
          executionId: "execution-id-123456",
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
        execution: {
          sessionId: "session-id",
          executionId: "execution-id-123456",
          sessionName: "review",
          backend: "codex",
          cwd: "/workspace/review",
          command: [],
          environment: {},
        },
      },
    },
    assert: [isInvalid(["execution", "command"])],
  },
  {
    name: "accepts an agent execution attach response",
    input: {
      kind: "response",
      value: {
        type: "agent_execution_attached",
        requestId: controlRequestId,
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        executionPid: 4321,
        executionStartedAt: "2026-08-30T00:00:01.000Z",
      },
    },
    assert: [isValid()],
  },
  {
    name: "accepts an agent execution completion response",
    input: {
      kind: "response",
      value: {
        type: "agent_execution_completed",
        requestId: controlRequestId,
        operation: "run",
        operationId: "operation-id-123456",
        agentSessionId: "session-id",
        executionId: "execution-id-123456",
        process: { started: true, code: 0, interrupted: false, signal: null, pid: 4321 },
        session: {
          id: "session-id",
          name: "review",
          backend: "codex",
          status: "exited",
          workspaceId: "workspace-id",
          workspaceRoot: "/workspace/review",
          workspaceName: "workspace",
          useWorktree: false,
          setupRan: false,
          resuming: false,
          createdAt: "2026-08-30T00:00:00.000Z",
          updatedAt: "2026-08-30T00:00:00.000Z",
        },
      },
    },
    assert: [isValid()],
  },
] satisfies readonly OperationCase<"default", PairingInput, ValidationResult, EmptyContext>[];

const pairingTable: OperationTable<undefined, "default", PairingInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: pairingCases,
  execute: (_fixture, input) =>
    parseSchema(input.kind === "request" ? muximodControlRequestSchema : muximodControlResponseSchema, input.value),
  observe: () => ({}),
};

const paneListCases = [
  {
    name: "accepts the host pane list DTO",
    input: {
      panes: [
        {
          id: "pane-1",
          hostPaneId: "%1",
          sessionName: "muximod",
          windowId: "@0",
          kind: "shell",
          name: "shell",
          cwd: "/tmp",
          workspaceId: null,
          agentId: null,
          state: "running",
          title: null,
          recentOutput: "recent pane output",
          lastSeenAt: "2026-08-09T00:00:00.000Z",
        },
      ],
    },
    assert: [isValid()],
  },
  {
    name: "rejects a pane list with an unknown field",
    input: { panes: [], legacyPanes: [] },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

type PaneCreateInput = {
  placement: "window" | "right" | "bottom";
  targetPaneId: string | null;
  workspaceId?: string;
  useWorktree?: boolean;
};
const paneCreateCases = [
  {
    name: "allows a new tmux window without a target",
    input: { placement: "window", targetPaneId: null },
    assert: [isValid()],
  },
  {
    name: "allows a right split with a target pane",
    input: { placement: "right", targetPaneId: "%0" },
    assert: [isValid()],
  },
  {
    name: "rejects a split without a target pane",
    input: { placement: "bottom", targetPaneId: null },
    assert: [isInvalid()],
  },
  {
    name: "rejects a split workspace override without a worktree",
    input: { placement: "right", targetPaneId: "%0", workspaceId: "workspace-1" },
    assert: [isInvalid(["workspaceId"])],
  },
  {
    name: "allows a worktree split with a workspace override",
    input: { placement: "right", targetPaneId: "%0", workspaceId: "workspace-1", useWorktree: true },
    assert: [isValid()],
  },
] satisfies readonly OperationCase<"default", PaneCreateInput, ValidationResult, EmptyContext>[];
const paneCreateTable: OperationTable<undefined, "default", PaneCreateInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: paneCreateCases,
  execute: (_fixture, input) =>
    parseSchema(createPaneRequestSchema, {
      sessionName: "muximod",
      kind: "shell",
      name: "shell",
      agentId: null,
      useWorktree: false,
      ...input,
    }),
  observe: () => ({}),
};

type SessionCreateInput = { name: string; workspaceId?: string };
const sessionCases = [
  {
    name: "accepts the selected workspace for a new session",
    input: { name: "review", workspaceId: "workspace-1" },
    assert: [isValid()],
  },
  { name: "rejects a session without a workspace selection", input: { name: "review" }, assert: [isInvalid()] },
] satisfies readonly OperationCase<"default", SessionCreateInput, ValidationResult, EmptyContext>[];
const sessionTable: OperationTable<undefined, "default", SessionCreateInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: sessionCases,
  execute: (_fixture, input) => parseSchema(createSessionRequestSchema, input),
  observe: () => ({}),
};

type SessionManageInput = { name: string };
const sessionManageCases = [
  {
    name: "accepts an existing tmux session name",
    input: { name: "desktop" },
    assert: [isValid()],
  },
  {
    name: "trims an existing tmux session name",
    input: { name: " desktop " },
    assert: [isValid({ name: "desktop" })],
  },
  {
    name: "rejects a tmux session name with unsupported characters",
    input: { name: "desktop/main" },
    assert: [isInvalid(["name"])],
  },
] satisfies readonly OperationCase<"default", SessionManageInput, ValidationResult, EmptyContext>[];
const sessionManageTable: OperationTable<undefined, "default", SessionManageInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: sessionManageCases,
  execute: (_fixture, input) => parseSchema(manageSessionRequestSchema, input),
  observe: () => ({}),
};

type WorkspaceInput = { workspaceId: string; mode: "workspace" | "worktree" } & Record<string, unknown>;
const workspaceCases = [
  {
    name: "accepts a direct workspace selection",
    input: { workspaceId: "workspace-1", mode: "workspace" },
    assert: [isValid()],
  },
  {
    name: "accepts a workspace worktree selection",
    input: { workspaceId: "workspace-1", mode: "worktree" },
    assert: [isValid()],
  },
  {
    name: "rejects a workspace selection with an unknown field",
    input: { workspaceId: "workspace-1", mode: "workspace", legacyMode: "workspace" },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", WorkspaceInput, ValidationResult, EmptyContext>[];
const workspaceTable: OperationTable<undefined, "default", WorkspaceInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: workspaceCases,
  execute: (_fixture, input) => parseSchema(workspaceSelectionSchema, input),
  observe: () => ({}),
};

const paneWorkspaceCases = [
  {
    name: "accepts a pane request that selects a workspace by id",
    input: {
      sessionName: "muximod",
      kind: "agent",
      name: "review",
      workspaceId: "workspace-1",
      agentId: "codex",
      useWorktree: true,
      placement: "window",
      targetPaneId: null,
    },
    assert: [isValid()],
  },
  {
    name: "accepts a worktree agent split",
    input: {
      sessionName: "muximod",
      kind: "agent",
      name: "review",
      workspaceId: "workspace-1",
      agentId: "codex",
      useWorktree: true,
      placement: "right",
      targetPaneId: "%0",
    },
    assert: [isValid()],
  },
  {
    name: "accepts a worktree shell in a new window",
    input: {
      sessionName: "muximod",
      kind: "shell",
      name: "shell",
      workspaceId: "workspace-1",
      agentId: null,
      useWorktree: true,
      placement: "window",
      targetPaneId: null,
    },
    assert: [isValid()],
  },
  {
    name: "accepts a worktree shell split",
    input: {
      sessionName: "muximod",
      kind: "shell",
      name: "shell",
      workspaceId: "workspace-1",
      agentId: null,
      useWorktree: true,
      placement: "bottom",
      targetPaneId: "%0",
    },
    assert: [isValid()],
  },
  {
    name: "rejects a pane request with an unknown field",
    input: {
      sessionName: "muximod",
      kind: "shell",
      name: "shell",
      agentId: null,
      useWorktree: false,
      placement: "window",
      targetPaneId: null,
      legacyName: "shell",
    },
    assert: [isInvalid()],
  },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];
const paneWorkspaceTable: OperationTable<undefined, "default", unknown, ValidationResult, EmptyContext> =
  createValidationTable(paneWorkspaceCases, createPaneRequestSchema);

type FrameInput = { data: string | Uint8Array };
type FrameResult = ReturnType<typeof decodeClientControlFrame>;
const clientFrame = {
  type: "claim",
  version: terminalProtocolVersion,
  cols: 80,
  rows: 24,
} as const;
const frameCases = [
  {
    name: "decodes a UTF-8 text control frame at the protocol boundary",
    input: { data: new TextEncoder().encode(encodeClientControlFrame(clientFrame)) },
    assert: [
      returns<EmptyContext, FrameResult>({
        ok: true,
        message: { type: "claim", version: terminalProtocolVersion, cols: 80, rows: 24 },
      }),
    ],
  },
  {
    name: "classifies malformed JSON before schema validation",
    input: { data: "not-json" },
    assert: [
      returns<EmptyContext, FrameResult>({ ok: false, code: "invalid_json", message: "Invalid JSON control frame" }),
    ],
  },
  {
    name: "classifies a protocol version mismatch explicitly",
    input: { data: JSON.stringify({ type: "claim", version: 99 }) },
    assert: [
      returns<EmptyContext, FrameResult>({
        ok: false,
        code: "unsupported_version",
        message: "Unsupported terminal protocol version: 99",
      }),
    ],
  },
  {
    name: "classifies a stale copy-mode message by protocol version",
    input: { data: JSON.stringify({ type: "enter_copy_mode", version: 1 }) },
    assert: [
      returns<EmptyContext, FrameResult>({
        ok: false,
        code: "unsupported_version",
        message: "Unsupported terminal protocol version: 1",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", FrameInput, FrameResult, EmptyContext>[];

const frameTable: OperationTable<undefined, "default", FrameInput, FrameResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: frameCases,
  execute: (_fixture, input) => decodeClientControlFrame(input.data),
  observe: () => ({}),
};

const clientEncodingTable: OperationTable<undefined, "default", typeof clientFrame, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: [
    {
      name: "encodes a validated client control message",
      input: clientFrame,
      assert: [returns<EmptyContext, string>(JSON.stringify(clientFrame))],
    },
  ],
  execute: (_fixture, input) => encodeClientControlFrame(input),
  observe: () => ({}),
};

const serverFrame = {
  type: "viewport",
  version: terminalProtocolVersion,
  owner: "mobile",
  reason: "attached",
} as const;
const encodingTable: OperationTable<undefined, "default", typeof serverFrame, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: [
    {
      name: "encodes a validated server control message",
      input: serverFrame,
      assert: [returns<EmptyContext, string>(JSON.stringify(serverFrame))],
    },
  ],
  execute: (_fixture, input) => encodeServerControlFrame(input),
  observe: () => ({}),
};

type ServerFrameResult = ReturnType<typeof decodeServerControlFrame>;
const serverFrameCases = [
  {
    name: "decodes a UTF-8 server control frame at the protocol boundary",
    input: { data: new TextEncoder().encode(encodeServerControlFrame(serverFrame)) },
    assert: [returns<EmptyContext, ServerFrameResult>({ ok: true, message: serverFrame })],
  },
  {
    name: "classifies malformed server JSON before schema validation",
    input: { data: "not-json" },
    assert: [
      returns<EmptyContext, ServerFrameResult>({
        ok: false,
        code: "invalid_json",
        message: "Invalid JSON control frame",
      }),
    ],
  },
  {
    name: "classifies an unsupported server protocol version explicitly",
    input: { data: JSON.stringify({ ...serverFrame, version: 99 }) },
    assert: [
      returns<EmptyContext, ServerFrameResult>({
        ok: false,
        code: "unsupported_version",
        message: "Unsupported terminal protocol version: 99",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", FrameInput, ServerFrameResult, EmptyContext>[];

const serverFrameTable: OperationTable<undefined, "default", FrameInput, ServerFrameResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: serverFrameCases,
  execute: (_fixture, input) => decodeServerControlFrame(input.data),
  observe: () => ({}),
};

describe("protocol schemas", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, createValidationTable(clientCases, clientControlMessageSchema));
  runOperationTable(register, createValidationTable(serverCases, serverControlMessageSchema));
  runOperationTable(register, createValidationTable(eventCases, muximodEventSchema));
  runOperationTable(register, createValidationTable(healthCases, muximodHealthSchema));
  runOperationTable(register, createValidationTable(capabilitiesCases, muximodCapabilitiesSchema));
  runOperationTable(register, operationStatusTable);
  runOperationTable(register, operationAcceptedTable);
  runOperationTable(register, pairingTable);
  runOperationTable(register, createValidationTable(paneListCases, paneListResponseSchema));
  runOperationTable(register, paneCreateTable);
  runOperationTable(register, sessionTable);
  runOperationTable(register, sessionManageTable);
  runOperationTable(register, workspaceTable);
  runOperationTable(register, paneWorkspaceTable);
  runOperationTable(register, frameTable);
  runOperationTable(register, clientEncodingTable);
  runOperationTable(register, encodingTable);
  runOperationTable(register, serverFrameTable);
});
