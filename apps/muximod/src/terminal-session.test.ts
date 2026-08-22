import { EventEmitter } from "node:events";
import { describe, it, vi } from "vitest";
import { muximodSocketReadyState } from "@muximo/application";
import { clientControlMessageSchema, maxPasteImageBase64Length, serverControlMessageSchema, terminalProtocolVersion } from "@muximo/contract";
import {
  hasObserved,
  runScenarioTable,
  type FixtureHandle,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { ImagePasteInput, ImagePasteResult, PtyProcess } from "@muximo/infrastructure";
import { TerminalSession, TerminalSessionRegistry, type TerminalSessionOptions } from "./terminal-session.js";

type SessionStep =
  | { type: "connect"; socket: "first" | "second"; target?: string; credentials?: "resume-first" }
  | { type: "raw-connect"; socket: "first" | "second" }
  | { type: "network-close"; socket: "first" | "second" }
  | { type: "detach"; socket: "first" | "second" }
  | { type: "emit-output"; value: string }
  | { type: "send-input"; value: string }
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
  pasteCalls: number;
  pasteTargets: readonly string[];
};
type SessionFixture = ReturnType<typeof createHarness> & { sockets: Partial<Record<"first" | "second", FakeSocket>> };

const sessionFixture = (): FixtureHandle<SessionFixture> => {
  vi.useFakeTimers();
  const harness = createHarness({ resumeGraceMs: 100 });
  return {
    fixture: { ...harness, sockets: {} },
    cleanup: () => { vi.useRealTimers(); vi.restoreAllMocks(); },
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
    ],
  },
  {
    name: "releases the runtime only for an explicit detach",
    steps: [{ type: "connect", socket: "first" }, { type: "detach", socket: "first" }],
    assert: [hasObserved<SessionContext, undefined>("firstClosedReasons", ["detached"]), hasObserved<SessionContext, undefined>("releaseCalls", 1), hasObserved<SessionContext, undefined>("killed", 1), hasObserved<SessionContext, undefined>("registrySize", 0)],
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
    steps: [{ type: "connect", socket: "first" }, { type: "network-close", socket: "first" }, { type: "connect", socket: "second" }],
    assert: [hasObserved<SessionContext, undefined>("prepareCalls", 2), hasObserved<SessionContext, undefined>("spawnCalls", 1), hasObserved<SessionContext, undefined>("releaseCalls", 0), hasObserved<SessionContext, undefined>("secondErrors", ["attach_failed"])],
  },
  {
    name: "expires a parked runtime after the resume grace period",
    steps: [{ type: "connect", socket: "first" }, { type: "network-close", socket: "first" }, { type: "advance", milliseconds: 100 }],
    assert: [hasObserved<SessionContext, undefined>("releaseCalls", 1), hasObserved<SessionContext, undefined>("killed", 1), hasObserved<SessionContext, undefined>("registrySize", 0)],
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
    name: "rejects an image paste before the pane is attached",
    steps: [{ type: "raw-connect", socket: "first" }, { type: "paste-image" }],
    assert: [hasObserved<SessionContext, undefined>("pasteCalls", 0), hasObserved<SessionContext, undefined>("firstErrors", ["not_attached"])],
  },
  {
    name: "rejects an oversized image paste without calling the paster",
    steps: [{ type: "connect", socket: "first" }, { type: "paste-image", image: "A".repeat(maxPasteImageBase64Length) }],
    assert: [hasObserved<SessionContext, undefined>("pasteCalls", 0), hasObserved<SessionContext, undefined>("firstErrors", ["paste_image_too_large"])],
  },
] satisfies readonly ScenarioCase<"default", SessionStep, undefined, SessionContext>[];

const table: ScenarioTable<SessionFixture, "default", SessionStep, undefined, SessionContext> = {
  defaultFixture: sessionFixture,
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "connect") {
        const socket = new FakeSocket();
        fixture.sockets[step.socket] = socket;
        new TerminalSession(socket, fixture.options);
        const previousReady = fixture.sockets.first?.controls().find((message) => message.type === "ready");
        const credentials = step.credentials === "resume-first" && previousReady?.type === "ready"
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
      if (step.type === "network-close") fixture.sockets[step.socket]?.networkClose();
      if (step.type === "detach") {
        fixture.sockets[step.socket]?.receive(JSON.stringify({ type: "detach", version: terminalProtocolVersion }));
        await flush();
      }
      if (step.type === "emit-output") fixture.pty.emitOutput(step.value);
      if (step.type === "send-input") {
        fixture.sockets.second?.receive(Buffer.from(step.value), true);
        await flush();
      }
      if (step.type === "paste-image") {
        fixture.sockets.first?.receive(JSON.stringify({ type: "paste_image", version: terminalProtocolVersion, name: "photo.png", mimeType: "image/png", data: step.image ?? "AAEC" }));
        await flush();
      }
      if (step.type === "advance") vi.advanceTimersByTime(step.milliseconds);
    }
  },
  observe: (fixture) => ({
    prepareCalls: fixture.manager.prepare.mock.calls.length,
    spawnCalls: fixture.spawn.mock.calls.length,
    releaseCalls: fixture.lease.release.mock.calls.length,
    killed: fixture.pty.killed,
    registrySize: fixture.registry.size,
    secondResumed: fixture.sockets.second?.controls().some((message) => message.type === "ready" && message.resumed) ?? false,
    secondReady: fixture.sockets.second?.controls().some((message) => message.type === "ready") ?? false,
    secondErrors: fixture.sockets.second?.controls().filter((message) => message.type === "error").map((message) => message.code) ?? [],
    firstClosedReasons: fixture.sockets.first?.controls().filter((message) => message.type === "closed").map((message) => message.reason) ?? [],
    firstErrors: fixture.sockets.first?.controls().filter((message) => message.type === "error").map((message) => message.code) ?? [],
    binaryFrames: fixture.sockets.second?.binaryFrames() ?? [],
    writes: [...fixture.pty.writes],
    pasteCalls: fixture.paster.mock.calls.length,
    pasteTargets: fixture.paster.mock.calls.map((call) => call[0].paneId),
    leaseClaimCalls: fixture.lease.claimMobile.mock.calls.length,
  }),
};

describe("terminal session lifecycle", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createHarness(overrides: Partial<TerminalSessionOptions> = {}) {
  const pty = new FakePty(401);
  const lease = { id: "lease-1", target: "%0", paneId: "%0", windowId: "@0", sessionName: "muximod", claimMobile: vi.fn(), resize: vi.fn(), release: vi.fn() };
  const prepared = { target: "%0", pane: { paneId: "%0", windowId: "@0", sessionName: "muximod" }, snapshot: {} as never, attach: vi.fn(async () => lease), release: vi.fn() };
  let leaseActive = false;
  const manager = { prepare: vi.fn(() => { if (leaseActive) throw new Error("Viewport is already in use for tmux window: @0"); leaseActive = true; return prepared; }), tmux: { attachArgs: vi.fn(() => ["attach-session", "-t", "muximod"]) } };
  lease.release = vi.fn(() => { leaseActive = false; });
  const spawn = vi.fn(() => pty.asPty());
  const registry = new TerminalSessionRegistry();
  const paster = vi.fn<(input: ImagePasteInput) => ImagePasteResult>(() => ({ bytes: 3, name: "photo.png", tempFilePath: "/tmp/photo.png", clipboard: "unavailable" }));
  const options: TerminalSessionOptions = { cwd: "/tmp", defaultTarget: "muximod", viewportManager: manager as unknown as TerminalSessionOptions["viewportManager"], spawnPty: spawn as unknown as TerminalSessionOptions["spawnPty"], sessions: registry, imagePaster: paster, ...overrides };
  return { manager, prepared, lease, pty, spawn, registry, paster, options };
}

function attachFrame(target: string, credentials: { sessionId?: string; resumeToken?: string } = {}): string {
  return JSON.stringify(clientControlMessageSchema.parse({ type: "attach", version: terminalProtocolVersion, target, cols: 80, rows: 24, ...credentials }));
}

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

class FakeSocket extends EventEmitter {
  public readyState: number = muximodSocketReadyState.open;
  public readonly sent: Array<string | Uint8Array> = [];
  public send(data: string | Uint8Array): void { if (this.readyState !== muximodSocketReadyState.open) throw new Error("socket is closed"); this.sent.push(data); }
  public receive(data: string | Uint8Array, isBinary = false): void { this.emit("message", data, isBinary); }
  public networkClose(): void { this.readyState = muximodSocketReadyState.closed; this.emit("close"); }
  public close(): void { this.readyState = muximodSocketReadyState.closed; this.emit("close"); }
  public onMessage(listener: (data: string | Uint8Array, isBinary: boolean) => void): () => void { this.on("message", listener); return () => this.removeListener("message", listener); }
  public onClose(listener: () => void): () => void { this.on("close", listener); return () => this.removeListener("close", listener); }
  public onError(listener: (error: Error) => void): () => void { this.on("error", listener); return () => this.removeListener("error", listener); }
  public controls() { return this.sent.filter((frame): frame is string => typeof frame === "string").map((frame) => serverControlMessageSchema.parse(JSON.parse(frame))); }
  public binaryFrames(): string[] { return this.sent.filter((frame): frame is Uint8Array => typeof frame !== "string").map((frame) => Buffer.from(frame).toString("utf8")); }
}

class FakePty {
  public readonly writes: string[] = [];
  public readonly resizeCalls: Array<[number, number]> = [];
  public killed = 0;
  private dataHandler: ((data: string) => void) | undefined;
  public constructor(public readonly pid: number) {}
  public onData(handler: (data: string) => void): { dispose: () => void } { this.dataHandler = handler; return { dispose: () => { this.dataHandler = undefined; } }; }
  public onExit(_handler: (event: { exitCode: number; signal?: number }) => void): { dispose: () => void } { return { dispose: () => undefined }; }
  public write(data: string): void { this.writes.push(data); }
  public resize(cols: number, rows: number): void { this.resizeCalls.push([cols, rows]); }
  public kill(): void { this.killed += 1; }
  public emitOutput(data: string): void { this.dataHandler?.(data); }
  public asPty(): PtyProcess { return this as unknown as PtyProcess; }
}
