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
import { describe, it, vi } from "vitest";
import {
  classifyTerminalFlick,
  installTerminalFlickInput,
  type TerminalFlickDirection,
  terminalInputForFlick,
  terminalMouseWheelInput,
} from "./-terminal-flick";

type EmptyContext = {};
type FlickMetrics = { dx: number; dy: number; durationMs: number };
type FlickResult = { direction: TerminalFlickDirection; input: string } | null;

const flickCases = [
  {
    name: "maps a fast right flick",
    input: { dx: 72, dy: 3, durationMs: 180 },
    assert: [returns<EmptyContext, FlickResult>({ direction: "right", input: "\u001b[C" })],
  },
  {
    name: "maps a fast left flick",
    input: { dx: -72, dy: 3, durationMs: 180 },
    assert: [returns<EmptyContext, FlickResult>({ direction: "left", input: "\u001b[D" })],
  },
  {
    name: "maps a fast up flick",
    input: { dx: 2, dy: -72, durationMs: 180 },
    assert: [returns<EmptyContext, FlickResult>({ direction: "up", input: "\u001b[A" })],
  },
  {
    name: "maps a fast down flick",
    input: { dx: 2, dy: 72, durationMs: 180 },
    assert: [returns<EmptyContext, FlickResult>({ direction: "down", input: "\u001b[B" })],
  },
  {
    name: "rejects a short drag",
    input: { dx: 12, dy: 0, durationMs: 120 },
    assert: [returns<EmptyContext, FlickResult>(null)],
  },
  {
    name: "rejects a slow drag",
    input: { dx: 72, dy: 0, durationMs: 800 },
    assert: [returns<EmptyContext, FlickResult>(null)],
  },
  {
    name: "rejects a low velocity drag",
    input: { dx: 28, dy: 0, durationMs: 240 },
    assert: [returns<EmptyContext, FlickResult>(null)],
  },
] satisfies readonly OperationCase<"default", FlickMetrics, FlickResult, EmptyContext>[];

const flickTable: OperationTable<undefined, "default", FlickMetrics, FlickResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: flickCases,
  execute: (_fixture, input) => {
    const direction = classifyTerminalFlick(input);
    return direction ? { direction, input: terminalInputForFlick(direction) } : null;
  },
  observe: () => ({}),
};

type MouseWheelInput = { direction: "up" | "down"; column: number; row: number };
const mouseWheelCases = [
  {
    name: "encodes tmux wheel up input",
    input: { direction: "up", column: 12, row: 4 },
    assert: [returns<EmptyContext, string>("\u001b[<64;12;4M")],
  },
  {
    name: "encodes tmux wheel down input",
    input: { direction: "down", column: 3, row: 18 },
    assert: [returns<EmptyContext, string>("\u001b[<65;3;18M")],
  },
  {
    name: "clamps mouse coordinates to the terminal origin",
    input: { direction: "up", column: 0, row: -2 },
    assert: [returns<EmptyContext, string>("\u001b[<64;1;1M")],
  },
] satisfies readonly OperationCase<"default", MouseWheelInput, string, EmptyContext>[];

const mouseWheelTable: OperationTable<undefined, "default", MouseWheelInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: mouseWheelCases,
  execute: (_fixture, input) => terminalMouseWheelInput(input.direction, input.column, input.row),
  observe: () => ({}),
};

type PointerValues = { pointerId: number; clientX: number; clientY: number };
type FlickStep =
  | {
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
      now: number;
      values: PointerValues;
    }
  | {
      type: "advance";
      ms: number;
    };
type FlickContext = { inputs: readonly string[]; scrollDeltas: readonly number[] };
type FlickFixture = {
  container: HTMLElement;
  inputs: string[];
  scrollDeltas: number[];
  setNow: (value: number) => void;
  advanceTimers: (milliseconds: number) => void;
};

const flickFixture = (): FixtureHandle<FlickFixture> => {
  const container = createPointerSurface();
  const inputs: string[] = [];
  const scrollDeltas: number[] = [];
  vi.useFakeTimers();
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  const cleanupInput = installTerminalFlickInput(container, (input) => inputs.push(input), {
    onScroll: (deltaY) => scrollDeltas.push(deltaY),
  });
  return {
    fixture: {
      container,
      inputs,
      scrollDeltas,
      setNow: (value) => {
        now = value;
      },
      advanceTimers: (milliseconds) => vi.advanceTimersByTime(milliseconds),
    },
    cleanup: () => {
      cleanupInput();
      clock.mockRestore();
      vi.useRealTimers();
    },
  };
};

const gestureCases = [
  {
    name: "discards a gesture on pointercancel",
    steps: [
      { type: "pointerdown", now: 0, values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointermove", now: 90, values: { pointerId: 1, clientX: 120, clientY: 48 } },
      { type: "pointercancel", now: 90, values: { pointerId: 1, clientX: 120, clientY: 48 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("inputs", []),
      hasObserved<FlickContext, undefined>("scrollDeltas", []),
    ],
  },
  {
    name: "scrolls a deliberate vertical drag",
    steps: [
      { type: "pointerdown", now: 0, values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointermove", now: 300, values: { pointerId: 1, clientX: 120, clientY: 150 } },
      { type: "pointermove", now: 420, values: { pointerId: 1, clientX: 120, clientY: 174 } },
      { type: "pointerup", now: 500, values: { pointerId: 1, clientX: 120, clientY: 174 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("scrollDeltas", [30, 24]),
      hasObserved<FlickContext, undefined>("inputs", []),
    ],
  },
  {
    name: "forwards a fast vertical gesture as scrolling",
    steps: [
      { type: "pointerdown", now: 0, values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointerup", now: 180, values: { pointerId: 1, clientX: 120, clientY: 48 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("scrollDeltas", [-72]),
      hasObserved<FlickContext, undefined>("inputs", []),
    ],
  },
  {
    name: "discards a gesture when a second touch joins it",
    steps: [
      { type: "pointerdown", now: 0, values: { pointerId: 1, clientX: 10, clientY: 10 } },
      { type: "pointerdown", now: 0, values: { pointerId: 2, clientX: 20, clientY: 20 } },
      { type: "pointerup", now: 100, values: { pointerId: 1, clientX: 90, clientY: 10 } },
      { type: "pointerup", now: 100, values: { pointerId: 2, clientX: 20, clientY: 20 } },
    ],
    assert: [hasObserved<FlickContext, undefined>("inputs", [])],
  },
  {
    name: "repeats a horizontal flick while the pointer remains down",
    steps: [
      { type: "pointerdown", now: 0, values: { pointerId: 1, clientX: 10, clientY: 10 } },
      { type: "pointermove", now: 100, values: { pointerId: 1, clientX: 90, clientY: 10 } },
      { type: "advance", ms: 420 },
      { type: "advance", ms: 360 },
      { type: "pointerup", now: 900, values: { pointerId: 1, clientX: 90, clientY: 10 } },
    ],
    assert: [hasObserved<FlickContext, undefined>("inputs", ["\u001b[C", "\u001b[C", "\u001b[C"])],
  },
] satisfies readonly ScenarioCase<"default", FlickStep, undefined, FlickContext>[];

const gestureTable: ScenarioTable<FlickFixture, "default", FlickStep, undefined, FlickContext> = {
  defaultFixture: flickFixture,
  cases: gestureCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "advance") {
        fixture.advanceTimers(step.ms);
        continue;
      }
      fixture.setNow(step.now);
      dispatchPointer(fixture.container, step.type, step.values);
    }
  },
  observe: (fixture) => ({ inputs: [...fixture.inputs], scrollDeltas: [...fixture.scrollDeltas] }),
};

describe("terminal flick input", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, flickTable);
  runOperationTable(register, mouseWheelTable);
  runScenarioTable(register, gestureTable);
});

function createPointerSurface(): HTMLElement {
  const surface = new EventTarget() as EventTarget & Partial<HTMLElement>;
  surface.setPointerCapture = vi.fn();
  return surface as HTMLElement;
}

function dispatchPointer(surface: HTMLElement, type: string, values: PointerValues): void {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: "touch" },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  });
  surface.dispatchEvent(event);
}
