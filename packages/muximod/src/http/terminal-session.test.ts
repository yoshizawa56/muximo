import { EventEmitter } from "node:events";
import {
  clientControlMessageSchema,
  maxPasteImageBase64Length,
  serverControlMessageSchema,
  terminalProtocolVersion,
} from "@muximo/contract/api";
import {
  type ImagePasteInput,
  type MuximodSocketData,
  muximodSocketReadyState,
  type PtyProcess,
} from "@muximo/infrastructure/runtime";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it, vi } from "vitest";
import { TerminalSession, type TerminalSessionOptions, TerminalSessionRegistry } from "./terminal-session.js";

type SessionStep =
  | { type: "connect"; socket: "first" | "second"; target?: string; credentials?: "resume-first" }
  | { type: "raw-connect"; socket: "first" | "second" }
  | { type: "network-close"; socket: "first" | "second" }
  | { type: "detach"; socket: "first" | "second" }
  | { type: "emit-output"; value: string }
  | { type: "send-input"; value: string }
  | { type: "enter-copy-mode" }
  | { type: "paste-tmux-buffer" }
  | { type: "paste-image"; image?: string }
  | { type: "advance"; milliseconds: number };
type SessionContext = {
  prepareCalls: number;
  spawnCalls: number;
  releaseCalls: number;
  killed: number;
  registrySize: number;
  secondResumed: boolean;
  secondReady: boolean;
  secondErrors: readonly string[];
  firstClosedReasons: readonly string[];
  firstErrors: readonly string[];
  binaryFrames: readonly string[];
  writes: readonly string[];
  attachTargets: readonly string[];
  pasteCalls: number;
  pasteTargets: readonly string[];
  copyModeCalls: number;
  pasteTmuxBufferCalls: number;
  events: readonly string[];
};
type SessionFixtureKey = "pasteFailure";
type SessionFixture = ReturnType<typeof createHarness> & { sockets: Partial<Record<"first" | "second", FakeSocket>> };

const sessionFixture = (): FixtureHandle<SessionFixture> => {
  vi.useFakeTimers();
  const harness = createHarness({ resumeGraceMs: 100 });
  return {
    fixture: { ...harness, sockets: {} },
    cleanup: () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
  };
};

const pasteFailureFixture = (): FixtureHandle<SessionFixture> => {
  vi.useFakeTimers();
  const harness = createHarness({ resumeGraceMs: 100 }, true);
  return {
    fixture: { ...harness, sockets: {} },
    cleanup: () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    },
  };
};

const cases = [
  {
    name: "parks one PTY and viewport lease across a network reconnect",
    steps: [
      { type: "connect", socket: "first" },
      { type: "network-close", socket: "first" },
      { type: "connect", socket: "second", credentials: "resume-first" },
      { type: "emit-output", value: "resumed output" },
      { type: "send-input", value: "ls" },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("prepareCalls", 1),
      hasObserved<SessionContext, undefined>("spawnCalls", 1),
      hasObserved<SessionContext, undefined>("releaseCalls", 0),
      hasObserved<SessionContext, undefined>("killed", 0),
      hasObserved<SessionContext, undefined>("registrySize", 1),
      hasObserved<SessionContext, undefined>("secondResumed", true),
      hasObserved<SessionContext, undefined>("binaryFrames", ["resumed output"]),
      hasObserved<SessionContext, undefined>("writes", ["ls"]),
      hasObserved<SessionContext, undefined>("attachTargets", ["=muximo-mobile:@0.%0"]),
    ],
  },
  {
    name: "releases the runtime only for an explicit detach",
    steps: [
      { type: "connect", socket: "first" },
      { type: "detach", socket: "first" },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("firstClosedReasons", ["detached"]),
      hasObserved<SessionContext, undefined>("releaseCalls", 1),
      hasObserved<SessionContext, undefined>("killed", 1),
      hasObserved<SessionContext, undefined>("registrySize", 0),
    ],
  },
  {
    name: "allows a new pane to attach after the previous pane is explicitly detached",
    steps: [
      { type: "connect", socket: "first" },
      { type: "detach", socket: "first" },
      { type: "connect", socket: "second" },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("prepareCalls", 2),
      hasObserved<SessionContext, undefined>("spawnCalls", 2),
      hasObserved<SessionContext, undefined>("releaseCalls", 1),
      hasObserved<SessionContext, undefined>("events", [
        "prepare",
        "lease.release:start",
        "lease.release:end",
        "prepare",
      ]),
      hasObserved<SessionContext, undefined>("secondReady", true),
      hasObserved<SessionContext, undefined>("secondErrors", []),
      hasObserved<SessionContext, undefined>("registrySize", 1),
    ],
  },
  {
    name: "replaces a parked pane session when a different pane needs the same viewport",
    steps: [
      { type: "connect", socket: "first" },
      { type: "network-close", socket: "first" },
      { type: "connect", socket: "second", target: "%1" },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("prepareCalls", 3),
      hasObserved<SessionContext, undefined>("spawnCalls", 2),
      hasObserved<SessionContext, undefined>("releaseCalls", 1),
      hasObserved<SessionContext, undefined>("secondReady", true),
      hasObserved<SessionContext, undefined>("secondErrors", []),
      hasObserved<SessionContext, undefined>("registrySize", 1),
    ],
  },
  {
    name: "does not create a duplicate lease while the original session is parked",
    steps: [
      { type: "connect", socket: "first" },
      { type: "network-close", socket: "first" },
      { type: "connect", socket: "second" },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("prepareCalls", 2),
      hasObserved<SessionContext, undefined>("spawnCalls", 1),
      hasObserved<SessionContext, undefined>("releaseCalls", 0),
      hasObserved<SessionContext, undefined>("secondErrors", ["attach_failed"]),
    ],
  },
  {
    name: "expires a parked runtime after the resume grace period",
    steps: [
      { type: "connect", socket: "first" },
      { type: "network-close", socket: "first" },
      { type: "advance", milliseconds: 100 },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("releaseCalls", 1),
      hasObserved<SessionContext, undefined>("killed", 1),
      hasObserved<SessionContext, undefined>("registrySize", 0),
    ],
  },
  {
    name: "pastes an image into the attached pane and claims the viewport",
    steps: [{ type: "connect", socket: "first" }, { type: "paste-image" }],
    assert: [
      hasObserved<SessionContext, undefined>("pasteCalls", 1),
      hasObserved<SessionContext, undefined>("pasteTargets", ["%0"]),
      hasObserved<SessionContext, undefined>("firstErrors", []),
      hasObserved<SessionContext, undefined>("leaseClaimCalls", 1),
    ],
  },
  {
    name: "enters tmux copy mode without moving selection data to the client",
    steps: [{ type: "connect", socket: "first" }, { type: "enter-copy-mode" }],
    assert: [
      hasObserved<SessionContext, undefined>("copyModeCalls", 1),
      hasObserved<SessionContext, undefined>("pasteTmuxBufferCalls", 0),
      hasObserved<SessionContext, undefined>("firstErrors", []),
    ],
  },
  {
    name: "pastes the host-side tmux buffer into the attached pane",
    steps: [{ type: "connect", socket: "first" }, { type: "paste-tmux-buffer" }],
    assert: [
      hasObserved<SessionContext, undefined>("copyModeCalls", 0),
      hasObserved<SessionContext, undefined>("pasteTmuxBufferCalls", 1),
      hasObserved<SessionContext, undefined>("firstErrors", []),
    ],
  },
  {
    name: "rejects tmux actions before the pane is attached",
    steps: [{ type: "raw-connect", socket: "first" }, { type: "enter-copy-mode" }, { type: "paste-tmux-buffer" }],
    assert: [
      hasObserved<SessionContext, undefined>("copyModeCalls", 0),
      hasObserved<SessionContext, undefined>("pasteTmuxBufferCalls", 0),
      hasObserved<SessionContext, undefined>("firstErrors", ["not_attached", "not_attached"]),
    ],
  },
  {
    name: "rejects an image paste before the pane is attached",
    steps: [{ type: "raw-connect", socket: "first" }, { type: "paste-image" }],
    assert: [
      hasObserved<SessionContext, undefined>("pasteCalls", 0),
      hasObserved<SessionContext, undefined>("firstErrors", ["not_attached"]),
    ],
  },
  {
    name: "rejects an oversized image paste without calling the paster",
    steps: [
      { type: "connect", socket: "first" },
      { type: "paste-image", image: "A".repeat(maxPasteImageBase64Length) },
    ],
    assert: [
      hasObserved<SessionContext, undefined>("pasteCalls", 0),
      hasObserved<SessionContext, undefined>("firstErrors", ["paste_image_too_large"]),
    ],
  },
  {
    name: "reports an asynchronous image paste failure after claiming the viewport",
    fixture: "pasteFailure",
    steps: [{ type: "connect", socket: "first" }, { type: "paste-image" }],
    assert: [
      hasObserved<SessionContext, undefined>("pasteCalls", 1),
      hasObserved<SessionContext, undefined>("firstErrors", ["paste_image_failed"]),
      hasObserved<SessionContext, undefined>("leaseClaimCalls", 1),
    ],
  },
] satisfies readonly ScenarioCase<SessionFixtureKey, SessionStep, undefined, SessionContext>[];

const table: ScenarioTable<SessionFixture, SessionFixtureKey, SessionStep, undefined, SessionContext> = {
  defaultFixture: sessionFixture,
  fixtures: { pasteFailure: pasteFailureFixture },
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "connect") {
        const socket = new FakeSocket();
        fixture.sockets[step.socket] = socket;
        new TerminalSession(socket, fixture.options);
        const previousReady = fixture.sockets.first?.controls().find((message) => message.type === "ready");
        const credentials =
          step.credentials === "resume-first" && previousReady?.type === "ready"
            ? { sessionId: previousReady.sessionId, resumeToken: previousReady.resumeToken }
            : {};
        socket.receive(attachFrame(step.target ?? "%0", credentials));
        await flush();
      }
      if (step.type === "raw-connect") {
        const socket = new FakeSocket();
        fixture.sockets[step.socket] = socket;
        new TerminalSession(socket, fixture.options);
        await flush();
      }
      if (step.type === "network-close") {
        fixture.sockets[step.socket]?.networkClose();
        await flush();
      }
      if (step.type === "detach") {
        fixture.sockets[step.socket]?.receive(JSON.stringify({ type: "detach", version: terminalProtocolVersion }));
        await flush();
      }
      if (step.type === "emit-output") fixture.pty.emitOutput(step.value);
      if (step.type === "send-input") {
        fixture.sockets.second?.receive(Buffer.from(step.value), true);
        await flush();
      }
      if (step.type === "enter-copy-mode") {
        fixture.sockets.first?.receive(JSON.stringify({ type: "enter_copy_mode", version: terminalProtocolVersion }));
        await flush();
      }
      if (step.type === "paste-tmux-buffer") {
        fixture.sockets.first?.receive(JSON.stringify({ type: "paste_tmux_buffer", version: terminalProtocolVersion }));
        await flush();
      }
      if (step.type === "paste-image") {
        fixture.sockets.first?.receive(
          JSON.stringify({
            type: "paste_image",
            version: terminalProtocolVersion,
            name: "photo.png",
            mimeType: "image/png",
            data: step.image ?? "AAEC",
          }),
        );
        await flush();
      }
      if (step.type === "advance") {
        vi.advanceTimersByTime(step.milliseconds);
        await flush();
      }
    }
  },
  observe: (fixture) => ({
    prepareCalls: fixture.manager.prepare.mock.calls.length,
    spawnCalls: fixture.spawn.mock.calls.length,
    releaseCalls: fixture.lease.release.mock.calls.length,
    killed: fixture.pty.killed,
    registrySize: fixture.registry.size,
    secondResumed:
      fixture.sockets.second?.controls().some((message) => message.type === "ready" && message.resumed) ?? false,
    secondReady: fixture.sockets.second?.controls().some((message) => message.type === "ready") ?? false,
    secondErrors:
      fixture.sockets.second
        ?.controls()
        .filter((message) => message.type === "error")
        .map((message) => message.code) ?? [],
    firstClosedReasons:
      fixture.sockets.first
        ?.controls()
        .filter((message) => message.type === "closed")
        .map((message) => message.reason) ?? [],
    firstErrors:
      fixture.sockets.first
        ?.controls()
        .filter((message) => message.type === "error")
        .map((message) => message.code) ?? [],
    binaryFrames: fixture.sockets.second?.binaryFrames() ?? [],
    writes: [...fixture.pty.writes],
    attachTargets: fixture.manager.buildAttachProcess.mock.calls.map(([target]) => target),
    pasteCalls: fixture.paster.mock.calls.length,
    pasteTargets: fixture.paster.mock.calls.map((call) => call[0].paneId),
    copyModeCalls: fixture.lease.enterCopyMode.mock.calls.length,
    pasteTmuxBufferCalls: fixture.lease.pasteTmuxBuffer.mock.calls.length,
    leaseClaimCalls: fixture.lease.claimMobile.mock.calls.length,
    events: [...fixture.events],
  }),
};

describe("terminal session lifecycle", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createHarness(overrides: Partial<TerminalSessionOptions> = {}, pasteFails = false) {
  const pty = new FakePty(401);
  const events: string[] = [];
  const lease = {
    id: "lease-1",
    target: "%0",
    paneId: "%0",
    windowId: "@0",
    sessionName: "muximod",
    claimMobile: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    enterCopyMode: vi.fn(async () => undefined),
    pasteTmuxBuffer: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const prepared = {
    target: "%0",
    pane: { paneId: "%0", windowId: "@0", sessionName: "muximod" },
    attachTarget: "=muximo-mobile:@0.%0",
    snapshot: {} as never,
    attach: vi.fn(async () => lease),
    release: vi.fn(async () => undefined),
  };
  let leaseActive = false;
  const manager = {
    prepare: vi.fn(async () => {
      events.push("prepare");
      if (leaseActive) throw new Error("Viewport is already in use for tmux window: @0");
      leaseActive = true;
      return prepared;
    }),
    buildAttachProcess: vi.fn((target: string) => ({
      file: "tmux",
      args: ["attach-session", "-t", target],
    })),
  };
  lease.release = vi.fn(async () => {
    events.push("lease.release:start");
    await Promise.resolve();
    leaseActive = false;
    events.push("lease.release:end");
  });
  const spawn = vi.fn(async () => pty.asPty());
  const registry = new TerminalSessionRegistry();
  const paster = vi.fn<(input: ImagePasteInput) => Promise<void>>(async () => {
    if (pasteFails) throw new Error("image paste failed");
  });
  const options: TerminalSessionOptions = {
    cwd: "/tmp",
    viewportManager: manager,
    spawnPty: spawn,
    sessions: registry,
    imagePaster: paster,
    ...overrides,
  };
  return { manager, prepared, lease, pty, spawn, registry, paster, options, events };
}

function attachFrame(target: string, credentials: { sessionId?: string; resumeToken?: string } = {}): string {
  return JSON.stringify(
    clientControlMessageSchema.parse({
      type: "attach",
      version: terminalProtocolVersion,
      target,
      cols: 80,
      rows: 24,
      ...credentials,
    }),
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class FakeSocket extends EventEmitter {
  public readyState: number = muximodSocketReadyState.open;
  public readonly sent: Array<string | Uint8Array> = [];
  public send(data: string | Uint8Array): void {
    if (this.readyState !== muximodSocketReadyState.open) throw new Error("socket is closed");
    this.sent.push(data);
  }
  public receive(data: MuximodSocketData, isBinary = false): void {
    this.emit("message", data, isBinary);
  }
  public networkClose(): void {
    this.readyState = muximodSocketReadyState.closed;
    this.emit("close");
  }
  public close(): void {
    this.readyState = muximodSocketReadyState.closed;
    this.emit("close");
  }
  public onMessage(listener: (data: MuximodSocketData, isBinary: boolean) => void): () => void {
    this.on("message", listener);
    return () => this.removeListener("message", listener);
  }
  public onClose(listener: () => void): () => void {
    this.on("close", listener);
    return () => this.removeListener("close", listener);
  }
  public onError(listener: (error: Error) => void): () => void {
    this.on("error", listener);
    return () => this.removeListener("error", listener);
  }
  public controls() {
    return this.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => serverControlMessageSchema.parse(JSON.parse(frame)));
  }
  public binaryFrames(): string[] {
    return this.sent
      .filter((frame): frame is Uint8Array => typeof frame !== "string")
      .map((frame) => Buffer.from(frame).toString("utf8"));
  }
}

class FakePty {
  public readonly writes: string[] = [];
  public killed = 0;
  private dataHandler: ((data: string) => void) | undefined;
  public constructor(public readonly pid: number) {}
  public onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandler = handler;
    return { dispose: () => (this.dataHandler = undefined) };
  }
  public onExit(_handler: (event: { exitCode: number; signal: number | null }) => void): { dispose: () => void } {
    return { dispose: () => undefined };
  }
  public async write(data: string): Promise<void> {
    this.writes.push(data);
  }
  public async resize(_cols: number, _rows: number): Promise<void> {}
  public async kill(): Promise<void> {
    this.killed += 1;
  }
  public emitOutput(data: string): void {
    this.dataHandler?.(data);
  }
  public asPty(): PtyProcess {
    return this as unknown as PtyProcess;
  }
}
