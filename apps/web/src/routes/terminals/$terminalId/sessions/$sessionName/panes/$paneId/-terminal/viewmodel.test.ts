import {
  type ClientControlMessage,
  encodeServerControlFrame,
  type ServerControlMessage,
  terminalProtocolVersion,
} from "@muximo/contract";
import {
  type FixtureHandle,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  createPasteImageMessage,
  createTerminalAttachMessage,
  handleControlMessage,
  nativeKeyboardToggleAction,
  type PaneResumeState,
  type PaneViewportOwner,
  resumeStateFromReady,
  terminalControlErrorDisposition,
  terminalSessionCleanupMode,
} from "./policy";
import { createTerminalResumeStore, type TerminalResumeStore } from "./viewmodel";

type EmptyContext = {};
type AttachResult = Extract<ClientControlMessage, { type: "attach" }>;
type AttachInput = { target: string; cols: number; rows: number; resume?: PaneResumeState };

const attachCases = [
  {
    name: "creates a versioned initial attach without resume credentials",
    input: { target: "%3", cols: 80, rows: 24 },
    assert: [
      returns<EmptyContext, AttachResult>({
        type: "attach",
        version: terminalProtocolVersion,
        target: "%3",
        cols: 80,
        rows: 24,
      }),
    ],
  },
  {
    name: "adds resume credentials for the selected pane",
    input: {
      target: "%3",
      cols: 100,
      rows: 30,
      resume: { sessionId: "terminal-1", resumeToken: "secret", target: "%3" },
    },
    assert: [
      returns<EmptyContext, AttachResult>({
        type: "attach",
        version: terminalProtocolVersion,
        target: "%3",
        cols: 100,
        rows: 30,
        sessionId: "terminal-1",
        resumeToken: "secret",
      }),
    ],
  },
  {
    name: "does not reuse resume credentials for another pane",
    input: {
      target: "%4",
      cols: 100,
      rows: 30,
      resume: { sessionId: "terminal-1", resumeToken: "secret", target: "%3" },
    },
    assert: [
      returns<EmptyContext, AttachResult>({
        type: "attach",
        version: terminalProtocolVersion,
        target: "%4",
        cols: 100,
        rows: 30,
      }),
    ],
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
    assert: [
      returns<EmptyContext, PasteImageResult>({
        type: "paste_image",
        version: terminalProtocolVersion,
        name: "screenshot.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      }),
    ],
  },
  {
    name: "omits the mime type when the picker did not provide one",
    input: { name: "photo", data: "AAEC" },
    assert: [
      returns<EmptyContext, PasteImageResult>({
        type: "paste_image",
        version: terminalProtocolVersion,
        name: "photo",
        data: "AAEC",
      }),
    ],
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
  {
    name: "exposes the resumed ready state",
    input: { message: readyMessage, target: "%3" },
    assert: [returns<EmptyContext, PaneResumeState>({ sessionId: "terminal-1", resumeToken: "secret", target: "%3" })],
  },
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

type NativeKeyboardToggleInput = {
  nativeKeyboardVisible: boolean;
  helperInputFocused: boolean;
};
type NativeKeyboardToggleResult = "show" | "hide";

const nativeKeyboardToggleCases = [
  {
    name: "hides when the native keyboard state is visible",
    input: { nativeKeyboardVisible: true, helperInputFocused: false },
    assert: [returns<EmptyContext, NativeKeyboardToggleResult>("hide")],
  },
  {
    name: "hides when the helper input is still focused despite stale visibility state",
    input: { nativeKeyboardVisible: false, helperInputFocused: true },
    assert: [returns<EmptyContext, NativeKeyboardToggleResult>("hide")],
  },
  {
    name: "shows when the helper input is not focused and the state is hidden",
    input: { nativeKeyboardVisible: false, helperInputFocused: false },
    assert: [returns<EmptyContext, NativeKeyboardToggleResult>("show")],
  },
] satisfies readonly OperationCase<"default", NativeKeyboardToggleInput, NativeKeyboardToggleResult, EmptyContext>[];

const nativeKeyboardToggleTable: OperationTable<
  undefined,
  "default",
  NativeKeyboardToggleInput,
  NativeKeyboardToggleResult,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: nativeKeyboardToggleCases,
  execute: (_fixture, input) => nativeKeyboardToggleAction(input.nativeKeyboardVisible, input.helperInputFocused),
  observe: () => ({}),
};

type TerminalControlErrorInput = { code: string; retryable: boolean };
type TerminalControlErrorResult = "action" | "connection";

const terminalControlErrorCases = [
  {
    name: "keeps a tmux buffer failure on the connected terminal",
    input: { code: "paste_tmux_buffer_failed", retryable: false },
    assert: [returns<EmptyContext, TerminalControlErrorResult>("action")],
  },
  {
    name: "keeps an image paste failure on the connected terminal",
    input: { code: "paste_image_failed", retryable: false },
    assert: [returns<EmptyContext, TerminalControlErrorResult>("action")],
  },
  {
    name: "treats a retryable attach failure as a connection failure",
    input: { code: "attach_failed", retryable: true },
    assert: [returns<EmptyContext, TerminalControlErrorResult>("connection")],
  },
  {
    name: "treats a resume target mismatch as a connection failure",
    input: { code: "resume_target_mismatch", retryable: false },
    assert: [returns<EmptyContext, TerminalControlErrorResult>("connection")],
  },
  {
    name: "treats an unknown non-retryable error as a connection failure",
    input: { code: "unknown_error", retryable: false },
    assert: [returns<EmptyContext, TerminalControlErrorResult>("connection")],
  },
] satisfies readonly OperationCase<"default", TerminalControlErrorInput, TerminalControlErrorResult, EmptyContext>[];

const terminalControlErrorTable: OperationTable<
  undefined,
  "default",
  TerminalControlErrorInput,
  TerminalControlErrorResult,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: terminalControlErrorCases,
  execute: (_fixture, input) => terminalControlErrorDisposition(input.code, input.retryable),
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
    name: "decodes a contract-owned ready frame and exposes the resumed state",
    input: { rawMessage: encodeServerControlFrame(readyMessage) },
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

type ResumeStoreStep =
  | { type: "write"; key: string; state: PaneResumeState }
  | { type: "read"; key: string; target: string; store: "active" | "isolated" }
  | { type: "clear"; key: string; store: "active" | "isolated" };
type ResumeStoreFixture = {
  active: TerminalResumeStore;
  isolated: TerminalResumeStore;
  reads: Array<PaneResumeState | null>;
};
type ResumeStoreContext = { reads: readonly (PaneResumeState | null)[] };

const resumeStoreFixture = (): FixtureHandle<ResumeStoreFixture> => ({
  fixture: {
    active: createTerminalResumeStore(),
    isolated: createTerminalResumeStore(),
    reads: [],
  },
});

const resumeStoreState: PaneResumeState = {
  sessionId: "terminal-1",
  resumeToken: "secret",
  target: "%3",
};

const resumeStoreCases = [
  {
    name: "retains a credential across an SPA remount in the same tab",
    steps: [
      { type: "write", key: "endpoint:%3", state: resumeStoreState },
      { type: "read", key: "endpoint:%3", target: "%3", store: "active" },
    ],
    assert: [hasObserved<ResumeStoreContext, undefined>("reads", [resumeStoreState])],
  },
  {
    name: "clears a credential when the terminal is detached",
    steps: [
      { type: "write", key: "endpoint:%3", state: resumeStoreState },
      { type: "clear", key: "endpoint:%3", store: "active" },
      { type: "read", key: "endpoint:%3", target: "%3", store: "active" },
    ],
    assert: [hasObserved<ResumeStoreContext, undefined>("reads", [null])],
  },
  {
    name: "does not share a credential with another tab memory store",
    steps: [
      { type: "write", key: "endpoint:%3", state: resumeStoreState },
      { type: "read", key: "endpoint:%3", target: "%3", store: "isolated" },
    ],
    assert: [hasObserved<ResumeStoreContext, undefined>("reads", [null])],
  },
  {
    name: "does not reuse a credential for another pane target",
    steps: [
      { type: "write", key: "endpoint:%3", state: resumeStoreState },
      { type: "read", key: "endpoint:%3", target: "%4", store: "active" },
    ],
    assert: [hasObserved<ResumeStoreContext, undefined>("reads", [null])],
  },
] satisfies readonly ScenarioCase<"default", ResumeStoreStep, undefined, ResumeStoreContext>[];

const resumeStoreTable: ScenarioTable<ResumeStoreFixture, "default", ResumeStoreStep, undefined, ResumeStoreContext> = {
  defaultFixture: resumeStoreFixture,
  cases: resumeStoreCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      const store = step.type === "write" || step.store === "active" ? fixture.active : fixture.isolated;
      if (step.type === "write") store.write(step.key, step.state);
      if (step.type === "clear") store.clear(step.key);
      if (step.type === "read") fixture.reads.push(store.read(step.key, step.target));
    }
  },
  observe: (fixture) => ({ reads: [...fixture.reads] }),
};

describe("terminal pane handshake helpers", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, attachTable);
  runOperationTable(register, pasteImageTable);
  runOperationTable(register, resumeTable);
  runOperationTable(register, cleanupTable);
  runOperationTable(register, nativeKeyboardToggleTable);
  runOperationTable(register, terminalControlErrorTable);
  runOperationTable(register, controlTable);
  runScenarioTable(register, resumeStoreTable);
});
