import {
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
  type CustomKeyboardDirectionalFlickPreview,
  classifyCustomKeyboardFlick,
  installCustomKeyboardDirectionalFlickInput,
} from "./flick";
import type { CustomKeyboardFlickDirection } from "./viewmodel";

type EmptyContext = {};
type FlickMetrics = { dx: number; dy: number };

const flickCases = [
  {
    name: "maps a vertical flick toward up",
    input: { dx: 4, dy: -18 },
    assert: [returns<EmptyContext, CustomKeyboardFlickDirection | null>("up")],
  },
  {
    name: "maps a diagonal flick using its dominant axis",
    input: { dx: 20, dy: 8 },
    assert: [returns<EmptyContext, CustomKeyboardFlickDirection | null>("right")],
  },
  {
    name: "accepts the minimum directional movement",
    input: { dx: 12, dy: 0 },
    assert: [returns<EmptyContext, CustomKeyboardFlickDirection | null>("right")],
  },
  {
    name: "ignores a movement below the directional threshold",
    input: { dx: 11, dy: 0 },
    assert: [returns<EmptyContext, CustomKeyboardFlickDirection | null>(null)],
  },
] satisfies readonly OperationCase<"default", FlickMetrics, CustomKeyboardFlickDirection | null, EmptyContext>[];

const flickTable: OperationTable<
  undefined,
  "default",
  FlickMetrics,
  CustomKeyboardFlickDirection | null,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: flickCases,
  execute: (_fixture, input) => classifyCustomKeyboardFlick(input),
  observe: () => ({}),
};

type PointerValues = { pointerId: number; clientX: number; clientY: number };
type FlickStep =
  | { type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel"; values: PointerValues }
  | { type: "advance"; ms: number };
type FlickContext = {
  directions: readonly CustomKeyboardFlickDirection[];
  previewStates: readonly string[];
};
type FlickFixture = {
  container: HTMLElement;
  directions: string[];
  previews: Array<CustomKeyboardDirectionalFlickPreview | null>;
  advanceTimers: (milliseconds: number) => void;
};

const flickFixture = (): { fixture: FlickFixture; cleanup: () => void } => {
  const container = createPointerSurface();
  const directions: string[] = [];
  const previews: Array<CustomKeyboardDirectionalFlickPreview | null> = [];
  vi.useFakeTimers();
  const cleanupInput = installCustomKeyboardDirectionalFlickInput(container, {
    onDirection: (direction) => directions.push(direction),
    onPreviewChange: (preview) => previews.push(preview),
  });
  return {
    fixture: {
      container,
      directions,
      previews,
      advanceTimers: (milliseconds) => vi.advanceTimersByTime(milliseconds),
    },
    cleanup: () => {
      cleanupInput();
      vi.useRealTimers();
    },
  };
};

const gestureCases = [
  {
    name: "repeats the selected direction while the pointer remains down",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 40, clientY: 40 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 40, clientY: 24 } },
      { type: "advance", ms: 420 },
      { type: "advance", ms: 360 },
      { type: "pointerup", values: { pointerId: 1, clientX: 40, clientY: 24 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("directions", ["up", "up", "up"]),
      hasObserved<FlickContext, undefined>("previewStates", ["up:false", "up:true", "clear"]),
    ],
  },
  {
    name: "sends one direction and clears the preview when released",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 20, clientY: 20 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 36, clientY: 20 } },
      { type: "pointerup", values: { pointerId: 1, clientX: 36, clientY: 20 } },
      { type: "advance", ms: 1000 },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("directions", ["right"]),
      hasObserved<FlickContext, undefined>("previewStates", ["right:false", "clear"]),
    ],
  },
  {
    name: "stops repeating without sending another direction on pointercancel",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 30, clientY: 30 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 30, clientY: 46 } },
      { type: "pointercancel", values: { pointerId: 1, clientX: 30, clientY: 46 } },
      { type: "advance", ms: 1000 },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("directions", ["down"]),
      hasObserved<FlickContext, undefined>("previewStates", ["down:false", "clear"]),
    ],
  },
  {
    name: "changes direction while held and restarts the repeat delay",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 40, clientY: 40 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 40, clientY: 24 } },
      { type: "advance", ms: 420 },
      { type: "advance", ms: 180 },
      { type: "pointermove", values: { pointerId: 1, clientX: 60, clientY: 24 } },
      { type: "advance", ms: 419 },
      { type: "advance", ms: 1 },
      { type: "advance", ms: 180 },
      { type: "pointerup", values: { pointerId: 1, clientX: 60, clientY: 24 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("directions", ["up", "up", "right", "right"]),
      hasObserved<FlickContext, undefined>("previewStates", [
        "up:false",
        "up:true",
        "right:false",
        "right:true",
        "clear",
      ]),
    ],
  },
  {
    name: "stops in the neutral zone and accepts a new direction without release",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 40, clientY: 40 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 40, clientY: 24 } },
      { type: "advance", ms: 420 },
      { type: "pointermove", values: { pointerId: 1, clientX: 44, clientY: 40 } },
      { type: "advance", ms: 1000 },
      { type: "pointermove", values: { pointerId: 1, clientX: 40, clientY: 56 } },
      { type: "advance", ms: 420 },
      { type: "advance", ms: 180 },
      { type: "pointerup", values: { pointerId: 1, clientX: 40, clientY: 56 } },
    ],
    assert: [
      hasObserved<FlickContext, undefined>("directions", ["up", "down", "down"]),
      hasObserved<FlickContext, undefined>("previewStates", [
        "up:false",
        "up:true",
        "clear",
        "down:false",
        "down:true",
        "clear",
      ]),
    ],
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
      dispatchPointer(fixture.container, step.type, step.values);
    }
  },
  observe: (fixture) => ({
    directions: [...fixture.directions] as CustomKeyboardFlickDirection[],
    previewStates: fixture.previews.map((preview) => (preview ? `${preview.direction}:${preview.repeating}` : "clear")),
  }),
};

describe("custom keyboard directional flick", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, flickTable);
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
