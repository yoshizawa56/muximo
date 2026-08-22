import { describe, it } from "vitest";
import { terminalProtocolVersion, type ClientControlMessage, type ServerControlMessage } from "@muximo/contract";
import {
  hasObserved,
  noFixture,
  returns,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  createPasteImageMessage,
  createTerminalAttachMessage,
  handleControlMessage,
  resumeStateFromReady,
  terminalSessionCleanupMode,
  type PaneResumeState,
  type PaneViewportOwner,
} from "./-terminal-viewmodel";

type EmptyContext = {};
type AttachResult = Extract<ClientControlMessage, { type: "attach" }>;
type AttachInput = { target: string; cols: number; rows: number; resume?: PaneResumeState };

const attachCases = [
  {
    name: "creates a versioned initial attach without resume credentials",
    input: { target: "%3", cols: 80, rows: 24 },
    assert: [returns<EmptyContext, AttachResult>({ type: "attach", version: terminalProtocolVersion, target: "%3", cols: 80, rows: 24 })],
  },
  {
    name: "adds resume credentials for the selected pane",
    input: { target: "%3", cols: 100, rows: 30, resume: { sessionId: "terminal-1", resumeToken: "secret", target: "%3" } },
    assert: [returns<EmptyContext, AttachResult>({ type: "attach", version: terminalProtocolVersion, target: "%3", cols: 100, rows: 30, sessionId: "terminal-1", resumeToken: "secret" })],
  },
  {
    name: "does not reuse resume credentials for another pane",
    input: { target: "%4", cols: 100, rows: 30, resume: { sessionId: "terminal-1", resumeToken: "secret", target: "%3" } },
    assert: [returns<EmptyContext, AttachResult>({ type: "attach", version: terminalProtocolVersion, target: "%4", cols: 100, rows: 30 })],
  },
] satisfies readonly OperationCase<"default", AttachInput, AttachResult, EmptyContext>[];

const attachTable: OperationTable<undefined, "default", AttachInput, AttachResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: attachCases,
  execute: (_fixture, input) => createTerminalAttachMessage(input),
  observe: () => ({}),
};

type PasteImageInput = { name: string; mimeType?: string; data: string };
type PasteImageResult = Extract<ClientControlMessage, { type: "paste_image" }>;

const pasteImageCases = [
  {
    name: "builds a versioned image paste with a mime type",
    input: { name: "screenshot.png", mimeType: "image/png", data: "iVBORw0KGgo=" },
    assert: [returns<EmptyContext, PasteImageResult>({ type: "paste_image", version: terminalProtocolVersion, name: "screenshot.png", mimeType: "image/png", data: "iVBORw0KGgo=" })],
  },
  {
    name: "omits the mime type when the picker did not provide one",
    input: { name: "photo", data: "AAEC" },
    assert: [returns<EmptyContext, PasteImageResult>({ type: "paste_image", version: terminalProtocolVersion, name: "photo", data: "AAEC" })],
  },
] satisfies readonly OperationCase<"default", PasteImageInput, PasteImageResult, EmptyContext>[];

const pasteImageTable: OperationTable<undefined, "default", PasteImageInput, PasteImageResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: pasteImageCases,
  execute: (_fixture, input) => createPasteImageMessage(input),
  observe: () => ({}),
};

type ReadyMessage = Extract<ServerControlMessage, { type: "ready" }>;
const readyMessage: ReadyMessage = {
  type: "ready",
  version: terminalProtocolVersion,
  sessionId: "terminal-1",
  resumeToken: "secret",
  resumed: true,
  target: "%3",
  paneId: "%3",
  windowId: "@1",
  cols: 80,
  rows: 24,
};

type ResumeInput = { message: ReadyMessage; target: string };
const resumeCases = [
  { name: "exposes the resumed ready state", input: { message: readyMessage, target: "%3" }, assert: [returns<EmptyContext, PaneResumeState>({ sessionId: "terminal-1", resumeToken: "secret", target: "%3" })] },
] satisfies readonly OperationCase<"default", ResumeInput, PaneResumeState, EmptyContext>[];

const resumeTable: OperationTable<undefined, "default", ResumeInput, PaneResumeState, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: resumeCases,
  execute: (_fixture, input) => resumeStateFromReady(input.message, input.target),
  observe: () => ({}),
};

type CleanupInput = { effectTarget: string; currentTarget: string };
type CleanupResult = "preserve" | "detach";

const cleanupCases = [
  {
    name: "preserves a resumable session when the same pane is remounted",
    input: { effectTarget: "%3", currentTarget: "%3" },
    assert: [returns<EmptyContext, CleanupResult>("preserve")],
  },
  {
    name: "detaches the old session when switching to another pane",
    input: { effectTarget: "%3", currentTarget: "%4" },
    assert: [returns<EmptyContext, CleanupResult>("detach")],
  },
  {
    name: "detaches the old session when pane data is temporarily unavailable",
    input: { effectTarget: "%3", currentTarget: "" },
    assert: [returns<EmptyContext, CleanupResult>("detach")],
  },
] satisfies readonly OperationCase<"default", CleanupInput, CleanupResult, EmptyContext>[];

const cleanupTable: OperationTable<undefined, "default", CleanupInput, CleanupResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: cleanupCases,
  execute: (_fixture, input) => terminalSessionCleanupMode(input.effectTarget, input.currentTarget),
  observe: () => ({}),
};

type ControlFixture = {
  events: string[];
  resumed: boolean | null;
};
type ControlContext = { events: readonly string[]; resumed: boolean | null };
type ControlInput = { rawMessage: string };

const controlFixture = (): FixtureHandle<ControlFixture> => ({
  fixture: { events: [], resumed: null },
});

const controlCases = [
  {
    name: "keeps control frames separate and exposes the resumed ready state",
    input: { rawMessage: JSON.stringify(readyMessage) },
    assert: [
      hasObserved<ControlContext, undefined>("events", ["ready:terminal-1"]),
      hasObserved<ControlContext, undefined>("resumed", true),
    ],
  },
  {
    name: "reports invalid control data as non-retryable",
    input: { rawMessage: "not-json" },
    assert: [hasObserved<ControlContext, undefined>("events", ["error:invalid_control_frame:false"])],
  },
] satisfies readonly OperationCase<"default", ControlInput, undefined, ControlContext>[];

const controlTable: OperationTable<ControlFixture, "default", ControlInput, undefined, ControlContext> = {
  defaultFixture: controlFixture,
  cases: controlCases,
  execute: (fixture, input) => {
    handleControlMessage(input.rawMessage, {
      onReady: (message) => {
        fixture.resumed = message.resumed;
        fixture.events.push(`ready:${message.sessionId}`);
      },
      onClosed: (message) => fixture.events.push(`closed:${message.reason}`),
      onError: (message) => fixture.events.push(`error:${message.code}:${message.retryable}`),
      onViewport: (owner: PaneViewportOwner, reason: string) => fixture.events.push(`viewport:${owner}:${reason}`),
    });
  },
  observe: (fixture) => ({ events: [...fixture.events], resumed: fixture.resumed }),
};

describe("terminal pane handshake helpers", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, attachTable);
  runOperationTable(register, pasteImageTable);
  runOperationTable(register, resumeTable);
  runOperationTable(register, cleanupTable);
  runOperationTable(register, controlTable);
});
