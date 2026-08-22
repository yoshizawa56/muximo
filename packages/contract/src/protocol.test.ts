import { describe, expect, it } from "vitest";
import {
  runOperationTable,
  noFixture,
  returns,
  type Assertion,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  muximodControlRequestSchema,
  muximodControlResponseSchema,
  muximodEventSchema,
  clientControlMessageSchema,
  decodeClientControlFrame,
  createPaneRequestSchema,
  createSessionRequestSchema,
  maxPasteImageBase64Length,
  paneListResponseSchema,
  serverControlMessageSchema,
  encodeServerControlFrame,
  terminalProtocolVersion,
  workspaceSelectionSchema,
} from "./protocol.js";
import { encodePairingCode } from "./auth-crypto.js";

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
  const path = parsed.error?.issues?.[0]?.path?.map((segment) => typeof segment === "symbol" ? segment.toString() : segment);
  return { success: false, issuePath: path };
}

const clientCases = [
  { name: "accepts an attach request", input: { type: "attach", version: terminalProtocolVersion, target: "muximod", cols: 80, rows: 24 }, assert: [isValid({ type: "attach", version: terminalProtocolVersion, target: "muximod", cols: 80, rows: 24 })] },
  { name: "accepts a mobile claim request", input: { type: "claim", version: terminalProtocolVersion }, assert: [isValid({ type: "claim", version: terminalProtocolVersion })] },
  { name: "rejects an invalid terminal size", input: { type: "resize", version: terminalProtocolVersion, cols: 0, rows: 24 }, assert: [isInvalid(["cols"])] },
  { name: "accepts a resumed attach with paired credentials", input: { type: "attach", version: terminalProtocolVersion, target: "%3", cols: 80, rows: 24, sessionId: "terminal-1", resumeToken: "resume-token" }, assert: [isValid({ type: "attach", version: terminalProtocolVersion, target: "%3", cols: 80, rows: 24, sessionId: "terminal-1", resumeToken: "resume-token" })] },
  { name: "rejects an attach with only one resume credential", input: { type: "attach", version: terminalProtocolVersion, target: "%3", cols: 80, rows: 24, sessionId: "terminal-1" }, assert: [isInvalid()] },
  { name: "accepts an image paste request", input: { type: "paste_image", version: terminalProtocolVersion, name: "screenshot.png", mimeType: "image/png", data: "iVBORw0KGgo=" }, assert: [isValid({ type: "paste_image", version: terminalProtocolVersion, name: "screenshot.png", mimeType: "image/png", data: "iVBORw0KGgo=" })] },
  { name: "accepts an image paste without a mime type", input: { type: "paste_image", version: terminalProtocolVersion, name: "photo", data: "AAEC" }, assert: [isValid()] },
  { name: "rejects an image paste with an empty payload", input: { type: "paste_image", version: terminalProtocolVersion, name: "photo.png", data: "" }, assert: [isInvalid(["data"])] },
  { name: "rejects an image paste with a non-base64 payload", input: { type: "paste_image", version: terminalProtocolVersion, name: "photo.png", data: "not base64!" }, assert: [isInvalid(["data"])] },
  { name: "rejects an image paste with a control character in the name", input: { type: "paste_image", version: terminalProtocolVersion, name: "photo\n.png", data: "AAEC" }, assert: [isInvalid(["name"])] },
  { name: "rejects an image paste with a colon in the name", input: { type: "paste_image", version: terminalProtocolVersion, name: "photo:1.png", data: "AAEC" }, assert: [isInvalid(["name"])] },
  { name: "rejects an oversized image paste", input: { type: "paste_image", version: terminalProtocolVersion, name: "big.png", data: "A".repeat(maxPasteImageBase64Length + 1) }, assert: [isInvalid(["data"])] },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const serverCases = [
  { name: "describes the mobile viewport after attach", input: { type: "ready", version: terminalProtocolVersion, sessionId: "terminal-1", resumeToken: "resume-token", resumed: false, target: "project:0.1", paneId: "%3", windowId: "@1", cols: 80, rows: 24 }, assert: [isValid()] },
  { name: "describes a desktop takeover", input: { type: "viewport", version: terminalProtocolVersion, owner: "desktop", reason: "desktop_activity" }, assert: [isValid()] },
  { name: "requires a lifecycle reason on a closed frame", input: { type: "closed", version: terminalProtocolVersion, sessionId: "terminal-1", reason: "detached", code: null, signal: null }, assert: [isValid()] },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

const eventCases = [
  { name: "accepts a pane creation invalidation", input: { type: "session_updated", sessionName: "muximod", reason: "pane_created", revision: 1 }, assert: [isValid()] },
  { name: "rejects an event without a session scope", input: { type: "session_updated", reason: "pane_deleted", revision: 2 }, assert: [isInvalid()] },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

type PairingInput = { kind: "request" | "response"; value: unknown };
const pairingCases = [
  { name: "accepts a pairing request with a muximod endpoint", input: { kind: "request", value: { type: "create_pairing", muximodBaseUrl: "https://muximod.example" } }, assert: [isValid()] },
  { name: "accepts a pairing response with a raw pairing code", input: { kind: "response", value: { type: "pairing_created", pairingId: "pairing-1234567890123456", pairingCode: encodePairingCode({ v: 2, muximodBaseUrl: "https://muximod.example", serverId: "server-1234567890123456", pairingId: "pairing-1234567890123456", pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-", expiresAt: 4_102_444_800_000 }), payload: { v: 2, muximodBaseUrl: "https://muximod.example", serverId: "server-1234567890123456", pairingId: "pairing-1234567890123456", pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-", expiresAt: 4_102_444_800_000 } } }, assert: [isValid()] },
  { name: "accepts a pairing response", input: { kind: "response", value: { type: "pairing_result", pairingId: "pairing-1234567890123456", status: "approved", deviceId: "device-1" } }, assert: [isValid()] },
  { name: "rejects a pairing request without endpoint settings", input: { kind: "request", value: { type: "create_pairing" } }, assert: [isInvalid()] },
  { name: "rejects an unrecognized control response", input: { kind: "response", value: { type: "unexpected" } }, assert: [isInvalid()] },
  { name: "accepts an agent session adoption request", input: { kind: "request", value: { type: "adopt_agent_session", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456" } }, assert: [isValid()] },
  { name: "accepts an agent session release request", input: { kind: "request", value: { type: "release_agent_session", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456" } }, assert: [isValid()] },
  { name: "accepts a provider observation request", input: { kind: "request", value: { type: "observe_agent_session", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456", state: "waiting_input", recentOutput: "recent output" } }, assert: [isValid()] },
  { name: "accepts an agent session adopted response", input: { kind: "response", value: { type: "agent_session_adopted", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456" } }, assert: [isValid()] },
  { name: "accepts an agent session released response", input: { kind: "response", value: { type: "agent_session_released", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456" } }, assert: [isValid()] },
  { name: "accepts a provider observation response", input: { kind: "response", value: { type: "agent_session_observed", agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456", state: "waiting_input" } }, assert: [isValid()] },
] satisfies readonly OperationCase<"default", PairingInput, ValidationResult, EmptyContext>[];

const pairingTable: OperationTable<undefined, "default", PairingInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: pairingCases,
  execute: (_fixture, input) => parseSchema(input.kind === "request" ? muximodControlRequestSchema : muximodControlResponseSchema, input.value),
  observe: () => ({}),
};

const paneListCases = [{ name: "accepts the host pane list DTO", input: { panes: [{ id: "pane-1", tmuxPaneId: "%1", sessionName: "muximod", windowId: "@0", kind: "shell", name: "shell", cwd: "/tmp", workspaceId: null, agentId: null, state: "running", title: null, recentOutput: "recent pane output", lastSeenAt: "2026-08-09T00:00:00.000Z" }] }, assert: [isValid()] }] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];

type PaneCreateInput = { placement: "window" | "right" | "bottom"; targetPaneId: string | null; cwd?: string; workspaceId?: string; useWorktree?: boolean };
const paneCreateCases = [
  { name: "allows a new tmux window without a target", input: { placement: "window", targetPaneId: null }, assert: [isValid()] },
  { name: "allows a right split with a target pane", input: { placement: "right", targetPaneId: "%0" }, assert: [isValid()] },
  { name: "rejects a split without a target pane", input: { placement: "bottom", targetPaneId: null }, assert: [isInvalid()] },
  { name: "rejects a split cwd override", input: { placement: "right", targetPaneId: "%0", cwd: "/tmp" }, assert: [isInvalid(["cwd"])] },
  { name: "rejects a split workspace override without a worktree", input: { placement: "right", targetPaneId: "%0", workspaceId: "workspace-1" }, assert: [isInvalid(["workspaceId"])] },
  { name: "allows a worktree split with a workspace override", input: { placement: "right", targetPaneId: "%0", workspaceId: "workspace-1", useWorktree: true }, assert: [isValid()] },
] satisfies readonly OperationCase<"default", PaneCreateInput, ValidationResult, EmptyContext>[];
const paneCreateTable: OperationTable<undefined, "default", PaneCreateInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: paneCreateCases,
  execute: (_fixture, input) => parseSchema(createPaneRequestSchema, { sessionName: "muximod", kind: "shell", name: "shell", agentId: null, useWorktree: false, ...input }),
  observe: () => ({}),
};

type SessionCreateInput = { name: string; workspaceId?: string; cwd?: string };
const sessionCases = [
  { name: "accepts the selected workspace for a new session", input: { name: "review", workspaceId: "workspace-1" }, assert: [isValid()] },
  { name: "accepts a legacy cwd while clients migrate", input: { name: "review", cwd: "/work/muximo" }, assert: [isValid()] },
  { name: "rejects a session without a workspace selection", input: { name: "review" }, assert: [isInvalid()] },
] satisfies readonly OperationCase<"default", SessionCreateInput, ValidationResult, EmptyContext>[];
const sessionTable: OperationTable<undefined, "default", SessionCreateInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: sessionCases,
  execute: (_fixture, input) => parseSchema(createSessionRequestSchema, input),
  observe: () => ({}),
};

type WorkspaceInput = { workspaceId: string; mode: "workspace" | "worktree" };
const workspaceCases = [
  { name: "accepts a direct workspace selection", input: { workspaceId: "workspace-1", mode: "workspace" }, assert: [isValid()] },
  { name: "accepts a workspace worktree selection", input: { workspaceId: "workspace-1", mode: "worktree" }, assert: [isValid()] },
] satisfies readonly OperationCase<"default", WorkspaceInput, ValidationResult, EmptyContext>[];
const workspaceTable: OperationTable<undefined, "default", WorkspaceInput, ValidationResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: workspaceCases,
  execute: (_fixture, input) => parseSchema(workspaceSelectionSchema, input),
  observe: () => ({}),
};

const paneWorkspaceCases = [
  { name: "accepts a pane request that selects a workspace by id", input: { sessionName: "muximod", kind: "agent", name: "review", workspaceId: "workspace-1", agentId: "codex", useWorktree: true, placement: "window", targetPaneId: null }, assert: [isValid()] },
  { name: "accepts a worktree agent split", input: { sessionName: "muximod", kind: "agent", name: "review", workspaceId: "workspace-1", agentId: "codex", useWorktree: true, placement: "right", targetPaneId: "%0" }, assert: [isValid()] },
  { name: "accepts a worktree shell in a new window", input: { sessionName: "muximod", kind: "shell", name: "shell", workspaceId: "workspace-1", agentId: null, useWorktree: true, placement: "window", targetPaneId: null }, assert: [isValid()] },
  { name: "accepts a worktree shell split", input: { sessionName: "muximod", kind: "shell", name: "shell", workspaceId: "workspace-1", agentId: null, useWorktree: true, placement: "bottom", targetPaneId: "%0" }, assert: [isValid()] },
] satisfies readonly OperationCase<"default", unknown, ValidationResult, EmptyContext>[];
const paneWorkspaceTable: OperationTable<undefined, "default", unknown, ValidationResult, EmptyContext> = createValidationTable(paneWorkspaceCases, createPaneRequestSchema);

type FrameInput = { data: string | Uint8Array };
type FrameResult = ReturnType<typeof decodeClientControlFrame>;
const frameCases = [
  {
    name: "decodes a UTF-8 text control frame at the protocol boundary",
    input: { data: new TextEncoder().encode(JSON.stringify({ type: "claim", version: terminalProtocolVersion })) },
    assert: [returns<EmptyContext, FrameResult>({ ok: true, message: { type: "claim", version: terminalProtocolVersion } })],
  },
  {
    name: "classifies malformed JSON before schema validation",
    input: { data: "not-json" },
    assert: [returns<EmptyContext, FrameResult>({ ok: false, code: "invalid_json", message: "Invalid JSON control frame" })],
  },
  {
    name: "classifies a protocol version mismatch explicitly",
    input: { data: JSON.stringify({ type: "claim", version: 99 }) },
    assert: [returns<EmptyContext, FrameResult>({ ok: false, code: "unsupported_version", message: "Unsupported terminal protocol version: 99" })],
  },
] satisfies readonly OperationCase<"default", FrameInput, FrameResult, EmptyContext>[];

const frameTable: OperationTable<undefined, "default", FrameInput, FrameResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: frameCases,
  execute: (_fixture, input) => decodeClientControlFrame(input.data),
  observe: () => ({}),
};

const serverFrame = { type: "viewport", version: terminalProtocolVersion, owner: "mobile", reason: "attached" } as const;
const encodingTable: OperationTable<undefined, "default", typeof serverFrame, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: [{ name: "encodes a validated server control message", input: serverFrame, assert: [returns<EmptyContext, string>(JSON.stringify(serverFrame))] }],
  execute: (_fixture, input) => encodeServerControlFrame(input),
  observe: () => ({}),
};

describe("protocol schemas", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, createValidationTable(clientCases, clientControlMessageSchema));
  runOperationTable(register, createValidationTable(serverCases, serverControlMessageSchema));
  runOperationTable(register, createValidationTable(eventCases, muximodEventSchema));
  runOperationTable(register, pairingTable);
  runOperationTable(register, createValidationTable(paneListCases, paneListResponseSchema));
  runOperationTable(register, paneCreateTable);
  runOperationTable(register, sessionTable);
  runOperationTable(register, workspaceTable);
  runOperationTable(register, paneWorkspaceTable);
  runOperationTable(register, frameTable);
  runOperationTable(register, encodingTable);
});
