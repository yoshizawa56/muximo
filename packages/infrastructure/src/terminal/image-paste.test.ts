// Tests for the terminal adapter stay co-located with its implementation.

import {
  type FixtureHandle,
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it, vi } from "vitest";
import {
  createImagePaster,
  type ImagePasteAdapter,
  type ImagePasteInput,
  type ImagePasteResult,
  inlineImageSequence,
  sanitizeInlineImageName,
} from "./image-paste.js";

const bytes = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff]);

type PasteCall = { kind: "set" | "paste" | "delete"; name: string; target?: string };

type PasteFixture = {
  adapter: ImagePasteAdapter;
  calls: PasteCall[];
  stagePaths: string[];
  cleanupPaths: string[];
  paster: (input: ImagePasteInput) => Promise<ImagePasteResult>;
  runOsascript?: ReturnType<typeof vi.fn<(script: string) => { status: number | null }>>;
};

type PasteFixtureKey = "darwin" | "darwinFailed" | "pasteFailure";

type PasteInput = { paneId: string; name: string; mimeType?: string; bytes: Buffer };
type PasteResult = ImagePasteResult;

type PasteContext = {
  setCount: number;
  deleteCount: number;
  bufferNamePattern: boolean;
  pastedTarget: string | undefined;
  sequence: string | undefined;
  result: ImagePasteResult | undefined;
  clipboard: ImagePasteResult["clipboard"] | undefined;
  osascriptCalls: number;
  osascriptIncludesAppKit: boolean;
  osascriptReferencesTempFile: boolean;
  stageCount: number;
  stagePaths: readonly string[];
  cleanupCount: number;
  cleanupPaths: readonly string[];
};

const createPasteFixture = (
  options: { platform?: NodeJS.Platform; osascriptStatus?: number | null; pasteFails?: boolean } = {},
): FixtureHandle<PasteFixture> => {
  const calls: PasteCall[] = [];
  const stagePaths: string[] = [];
  const cleanupPaths: string[] = [];
  const adapter: ImagePasteAdapter = {
    setBuffer: vi.fn<(name: string, _data: Buffer) => void>((name) => {
      calls.push({ kind: "set", name });
    }),
    pasteBuffer: vi.fn<(name: string, target: string) => void>((name, target) => {
      calls.push({ kind: "paste", name, target });
      if (options.pasteFails) throw new Error("tmux paste failed");
    }),
    deleteBuffer: vi.fn<(name: string) => void>((name) => {
      calls.push({ kind: "delete", name });
    }),
  };
  const runOsascript =
    options.platform === "darwin"
      ? vi.fn<(script: string) => { status: number | null }>(() => ({ status: options.osascriptStatus ?? 0 }))
      : undefined;
  const paster = createImagePaster({
    tmux: adapter,
    platform: options.platform ?? "linux",
    tempDir: "/tmp",
    stageImage: (input) => {
      const path = `/tmp/${input.name}`;
      stagePaths.push(path);
      return path;
    },
    cleanupImage: (path) => {
      cleanupPaths.push(path);
    },
    ...(runOsascript ? { runOsascript } : {}),
  });
  return { fixture: { adapter, calls, stagePaths, cleanupPaths, paster, runOsascript } };
};

const pasteCases = [
  {
    name: "pastes the image into the pane as an iTerm2 inline-image sequence",
    input: { paneId: "%3", name: "photo.png", mimeType: "image/png", bytes },
    assert: [
      hasObserved<PasteContext, PasteResult>("setCount", 1),
      hasObserved<PasteContext, PasteResult>("bufferNamePattern", true),
      hasObserved<PasteContext, PasteResult>("pastedTarget", "%3"),
      hasObserved<PasteContext, PasteResult>(
        "sequence",
        `\x1b]1337;file=inline=1;name=photo.png:${bytes.toString("base64")}\x07`,
      ),
      hasObserved<PasteContext, PasteResult>("deleteCount", 1),
      hasObserved<PasteContext, PasteResult>("stageCount", 0),
      hasObserved<PasteContext, PasteResult>("cleanupCount", 0),
    ],
  },
  {
    name: "reports the pasted byte count without staging a file off macOS",
    input: { paneId: "%3", name: "photo.png", mimeType: "image/png", bytes },
    assert: [
      hasObserved<PasteContext, PasteResult>("result", {
        bytes: bytes.length,
        name: "photo.png",
        clipboard: "unavailable",
      }),
      hasObserved<PasteContext, PasteResult>("stageCount", 0),
      hasObserved<PasteContext, PasteResult>("cleanupPaths", []),
    ],
  },
  {
    name: "sets the macOS clipboard when osascript succeeds",
    fixture: "darwin",
    input: { paneId: "%3", name: "photo.png", bytes },
    assert: [
      hasObserved<PasteContext, PasteResult>("clipboard", "set"),
      hasObserved<PasteContext, PasteResult>("osascriptCalls", 1),
      hasObserved<PasteContext, PasteResult>("osascriptIncludesAppKit", true),
      hasObserved<PasteContext, PasteResult>("osascriptReferencesTempFile", true),
      hasObserved<PasteContext, PasteResult>("stageCount", 1),
      hasObserved<PasteContext, PasteResult>("cleanupCount", 1),
    ],
  },
  {
    name: "reports a failed clipboard without failing the paste",
    fixture: "darwinFailed",
    input: { paneId: "%3", name: "photo.png", bytes },
    assert: [
      hasObserved<PasteContext, PasteResult>("clipboard", "failed"),
      hasObserved<PasteContext, PasteResult>("pastedTarget", "%3"),
      hasObserved<PasteContext, PasteResult>("deleteCount", 1),
      hasObserved<PasteContext, PasteResult>("stageCount", 1),
      hasObserved<PasteContext, PasteResult>("cleanupCount", 1),
    ],
  },
  {
    name: "skips the clipboard off macOS",
    input: { paneId: "%3", name: "photo.png", bytes },
    assert: [
      hasObserved<PasteContext, PasteResult>("clipboard", "unavailable"),
      hasObserved<PasteContext, PasteResult>("osascriptCalls", 0),
      hasObserved<PasteContext, PasteResult>("stageCount", 0),
      hasObserved<PasteContext, PasteResult>("cleanupCount", 0),
    ],
  },
  {
    name: "deletes the tmux buffer even when the paste fails",
    fixture: "pasteFailure",
    input: { paneId: "%3", name: "photo.png", bytes },
    assert: [
      hasError<PasteContext, PasteResult>({ message: "tmux paste failed" }),
      hasObserved<PasteContext, PasteResult>("setCount", 1),
      hasObserved<PasteContext, PasteResult>("deleteCount", 1),
      hasObserved<PasteContext, PasteResult>("stageCount", 0),
      hasObserved<PasteContext, PasteResult>("cleanupCount", 0),
    ],
  },
] satisfies readonly OperationCase<PasteFixtureKey, PasteInput, PasteResult, PasteContext>[];

const pasteTable: OperationTable<PasteFixture, PasteFixtureKey, PasteInput, PasteResult, PasteContext> = {
  defaultFixture: () => createPasteFixture(),
  fixtures: {
    darwin: () => createPasteFixture({ platform: "darwin", osascriptStatus: 0 }),
    darwinFailed: () => createPasteFixture({ platform: "darwin", osascriptStatus: 1 }),
    pasteFailure: () => createPasteFixture({ pasteFails: true }),
  },
  cases: pasteCases,
  execute: (fixture, input) => fixture.paster(input),
  observe: (fixture, result) => {
    const setBufferMock = fixture.adapter.setBuffer as ReturnType<typeof vi.fn<(name: string, data: Buffer) => void>>;
    const setCall = fixture.calls.find((call) => call.kind === "set");
    const pasted = fixture.calls.find((call) => call.kind === "paste");
    const sequence = setBufferMock.mock.calls[0]?.[1] ? String(setBufferMock.mock.calls[0][1]) : undefined;
    const osascriptScript = fixture.runOsascript?.mock.calls[0]?.[0];
    return {
      setCount: fixture.calls.filter((call) => call.kind === "set").length,
      deleteCount: fixture.calls.filter((call) => call.kind === "delete").length,
      bufferNamePattern: setCall ? /^muximod-paste-[0-9a-f]{12}$/.test(setCall.name) : false,
      pastedTarget: pasted?.target,
      sequence,
      result: result.ok ? result.value : undefined,
      clipboard: result.ok ? result.value.clipboard : undefined,
      osascriptCalls: fixture.runOsascript?.mock.calls.length ?? 0,
      osascriptIncludesAppKit: osascriptScript?.includes("ObjC.import('AppKit')") ?? false,
      osascriptReferencesTempFile: osascriptScript?.includes("/tmp/photo.png") ?? false,
      stageCount: fixture.stagePaths.length,
      stagePaths: [...fixture.stagePaths],
      cleanupCount: fixture.cleanupPaths.length,
      cleanupPaths: [...fixture.cleanupPaths],
    };
  },
};

type PureInput = { name: string; bytes?: Buffer };
type PureResult = string;
type PureContext = {};

const pureCases = [
  {
    name: "encodes the payload as standard base64",
    input: { name: "screenshot.png", bytes },
    assert: [
      returns<PureContext, PureResult>(`\x1b]1337;file=inline=1;name=screenshot.png:${bytes.toString("base64")}\x07`),
    ],
  },
  {
    name: "sanitizes names that could break the OSC header",
    input: { name: "a:b;c" },
    assert: [returns<PureContext, PureResult>("a_b_c")],
  },
  {
    name: "replaces control characters in the name",
    input: { name: "photo\n.png" },
    assert: [returns<PureContext, PureResult>("photo_.png")],
  },
  {
    name: "falls back to a generic name when the name is blank",
    input: { name: "  " },
    assert: [returns<PureContext, PureResult>("image")],
  },
] satisfies readonly OperationCase<"default", PureInput, PureResult, PureContext>[];

const pureTable: OperationTable<undefined, "default", PureInput, PureResult, PureContext> = {
  defaultFixture: noFixture(),
  cases: pureCases,
  execute: (_fixture, input) =>
    input.bytes ? inlineImageSequence(input.name, input.bytes) : sanitizeInlineImageName(input.name),
  observe: () => ({}),
};

describe("image paste adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, pasteTable);
  runOperationTable(register, pureTable);
});
