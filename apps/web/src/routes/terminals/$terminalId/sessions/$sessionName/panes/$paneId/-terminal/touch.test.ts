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
import { installTerminalTouchInput, terminalMouseWheelInput } from "./touch";

type EmptyContext = {};

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

type PointerValues = { pointerId: number; pointerType?: "mouse" | "touch"; clientX: number; clientY: number };
type TouchStep =
  | {
      type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel";
      values: PointerValues;
    }
  | {
      type: "touchstart";
      values: { touches: number };
    };
type TouchContext = {
  scrollDeltas: readonly number[];
  prevented: readonly boolean[];
};
type TouchFixtureKey = "native";
type TouchFixture = {
  container: HTMLElement;
  scrollDeltas: number[];
  prevented: boolean[];
};

const touchFixture = (suppressNativeTouch: boolean): FixtureHandle<TouchFixture> => {
  const container = createPointerSurface();
  const scrollDeltas: number[] = [];
  const prevented: boolean[] = [];
  const cleanupInput = installTerminalTouchInput(container, {
    suppressNativeTouch,
    onScroll: (deltaY) => scrollDeltas.push(deltaY),
  });
  return {
    fixture: {
      container,
      scrollDeltas,
      prevented,
    },
    cleanup: () => {
      cleanupInput();
    },
  };
};

const touchCases = [
  {
    name: "prevents a touch start from reaching xterm's native focus handler",
    steps: [{ type: "pointerdown", values: { pointerId: 1, clientX: 120, clientY: 120 } }],
    assert: [
      hasObserved<TouchContext, undefined>("scrollDeltas", []),
      hasObserved<TouchContext, undefined>("prevented", [true]),
    ],
  },
  {
    name: "leaves native terminal focus available outside shell mode",
    fixture: "native",
    steps: [
      { type: "touchstart", values: { touches: 1 } },
      { type: "pointerdown", values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointerup", values: { pointerId: 1, clientX: 120, clientY: 120 } },
    ],
    assert: [hasObserved<TouchContext, undefined>("prevented", [false, false, false])],
  },
  {
    name: "leaves a mouse start available for desktop terminal focus",
    steps: [{ type: "pointerdown", values: { pointerId: 1, pointerType: "mouse", clientX: 120, clientY: 120 } }],
    assert: [hasObserved<TouchContext, undefined>("prevented", [false])],
  },
  {
    name: "scrolls a deliberate vertical drag without sending terminal keys",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 120, clientY: 150 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 120, clientY: 174 } },
      { type: "pointerup", values: { pointerId: 1, clientX: 120, clientY: 174 } },
    ],
    assert: [hasObserved<TouchContext, undefined>("scrollDeltas", [30, 24])],
  },
  {
    name: "prevents WebKit touchstart from focusing xterm",
    steps: [{ type: "touchstart", values: { touches: 1 } }],
    assert: [hasObserved<TouchContext, undefined>("prevented", [true])],
  },
  {
    name: "scrolls a quick vertical flick when pointermove is not delivered",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointerup", values: { pointerId: 1, clientX: 120, clientY: 48 } },
    ],
    assert: [
      hasObserved<TouchContext, undefined>("scrollDeltas", [-72]),
      hasObserved<TouchContext, undefined>("prevented", [true, true]),
    ],
  },
  {
    name: "cancels a scroll gesture when a second finger starts",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 100, clientY: 100 } },
      { type: "pointerdown", values: { pointerId: 2, clientX: 180, clientY: 100 } },
      { type: "pointermove", values: { pointerId: 1, clientX: 100, clientY: 160 } },
      { type: "pointerup", values: { pointerId: 1, clientX: 100, clientY: 160 } },
      { type: "pointerup", values: { pointerId: 2, clientX: 180, clientY: 100 } },
    ],
    assert: [hasObserved<TouchContext, undefined>("scrollDeltas", [])],
  },
  {
    name: "discards a touch gesture on pointer cancel",
    steps: [
      { type: "pointerdown", values: { pointerId: 1, clientX: 120, clientY: 120 } },
      { type: "pointercancel", values: { pointerId: 1, clientX: 120, clientY: 48 } },
    ],
    assert: [hasObserved<TouchContext, undefined>("scrollDeltas", [])],
  },
] satisfies readonly ScenarioCase<TouchFixtureKey, TouchStep, undefined, TouchContext>[];

const touchTable: ScenarioTable<TouchFixture, TouchFixtureKey, TouchStep, undefined, TouchContext> = {
  defaultFixture: () => touchFixture(true),
  fixtures: {
    native: () => touchFixture(false),
  },
  cases: touchCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      const event =
        step.type === "touchstart"
          ? dispatchTouch(fixture.container, step.values.touches)
          : dispatchPointer(fixture.container, step.type, step.values);
      fixture.prevented.push(event.defaultPrevented);
    }
  },
  observe: (fixture) => ({
    scrollDeltas: [...fixture.scrollDeltas],
    prevented: [...fixture.prevented],
  }),
};

describe("terminal touch input", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, mouseWheelTable);
  runScenarioTable(register, touchTable);
});

function createPointerSurface(): HTMLElement {
  const surface = new EventTarget() as EventTarget & Partial<HTMLElement>;
  surface.setPointerCapture = vi.fn();
  return surface as HTMLElement;
}

function dispatchPointer(surface: HTMLElement, type: TouchStep["type"], values: PointerValues): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: values.pointerId },
    pointerType: { value: values.pointerType ?? "touch" },
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
  });
  surface.dispatchEvent(event);
  return event;
}

function dispatchTouch(surface: HTMLElement, touches: number): Event {
  const event = new Event("touchstart", { cancelable: true });
  Object.defineProperty(event, "touches", { value: { length: touches } });
  surface.dispatchEvent(event);
  return event;
}
