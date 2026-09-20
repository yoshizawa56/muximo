import {
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { installTerminalTextareaResidueGuard, type TerminalTextareaResidueGuard } from "./textarea-residue";

type ResidueEventName = "blur" | "compositionend" | "compositionstart" | "input" | "keydown" | "keyup";
type ResidueStep =
  | { type: "set-value"; value: string }
  | { type: "data"; data: string }
  | { type: "event"; name: ResidueEventName; keyCode?: number }
  | { type: "advance"; ms: number }
  | { type: "run-timers" }
  | { type: "snapshot" }
  | { type: "dispose" };

type ResidueFixture = {
  textarea: HTMLTextAreaElement & EventTarget;
  guard: TerminalTextareaResidueGuard;
  acceptedData: string[];
  advance: (milliseconds: number) => void;
  runTimers: () => void;
  pendingTimerCount: () => number;
  snapshots: string[];
};

type ResidueContext = {
  value: string;
  pendingTimerCount: number;
  acceptedData: readonly string[];
  snapshots: readonly string[];
};

const residueCases = [
  {
    name: "clears input residue after xterm emits terminal data",
    steps: [{ type: "set-value", value: "......" }, { type: "data", data: "......" }, { type: "run-timers" }],
    assert: [
      hasObserved<ResidueContext, undefined>("value", ""),
      hasObserved<ResidueContext, undefined>("pendingTimerCount", 0),
    ],
  },
  {
    name: "keeps composition text until composition finishes",
    steps: [
      { type: "event", name: "compositionstart" },
      { type: "set-value", value: "composing" },
      { type: "data", data: "composing" },
      { type: "run-timers" },
    ],
    assert: [
      hasObserved<ResidueContext, undefined>("value", "composing"),
      hasObserved<ResidueContext, undefined>("pendingTimerCount", 0),
    ],
  },
  {
    name: "clears committed composition text after xterm finalization",
    steps: [
      { type: "event", name: "compositionstart" },
      { type: "set-value", value: "committed" },
      { type: "event", name: "compositionend" },
      { type: "run-timers" },
    ],
    assert: [
      hasObserved<ResidueContext, undefined>("value", ""),
      hasObserved<ResidueContext, undefined>("pendingTimerCount", 0),
    ],
  },
  {
    name: "does not postpone the first residue sweep during repeated emissions",
    steps: [
      { type: "set-value", value: "......" },
      { type: "data", data: "......" },
      { type: "data", data: "......" },
    ],
    assert: [
      hasObserved<ResidueContext, undefined>("value", "......"),
      hasObserved<ResidueContext, undefined>("pendingTimerCount", 1),
    ],
  },
  {
    name: "cancels a pending sweep when the terminal is disposed",
    steps: [
      { type: "set-value", value: "retained" },
      { type: "data", data: "retained" },
      { type: "dispose" },
      { type: "run-timers" },
    ],
    assert: [
      hasObserved<ResidueContext, undefined>("value", "retained"),
      hasObserved<ResidueContext, undefined>("pendingTimerCount", 0),
    ],
  },
  {
    name: "keeps the textarea value for a deferred keyCode 229 diff",
    steps: [
      { type: "set-value", value: "j" },
      { type: "event", name: "input" },
      { type: "data", data: "j" },
      { type: "event", name: "keydown", keyCode: 229 },
      { type: "run-timers" },
      { type: "snapshot" },
      { type: "set-value", value: "jk" },
      { type: "data", data: "k" },
      { type: "run-timers" },
      { type: "snapshot" },
    ],
    assert: [hasObserved<ResidueContext, undefined>("snapshots", ["j", ""])],
  },
  {
    name: "suppresses a duplicate printable emission from one native input",
    steps: [
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "." },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", ["."])],
  },
  {
    name: "correlates WebKit input-before-keydown events as one native input",
    steps: [
      { type: "event", name: "input" },
      { type: "data", data: "." },
      { type: "event", name: "keydown", keyCode: 229 },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", ["."])],
  },
  {
    name: "correlates keydown-before-input events as one native input",
    steps: [
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "." },
      { type: "event", name: "input" },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", ["."])],
  },
  {
    name: "allows intentional repeated keydown input",
    steps: [
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "." },
      { type: "event", name: "keyup", keyCode: 190 },
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", [".", "."])],
  },
  {
    name: "allows repeated input-first characters without an intervening keyup",
    steps: [
      { type: "event", name: "input" },
      { type: "data", data: "." },
      { type: "event", name: "keydown", keyCode: 229 },
      { type: "data", data: "." },
      { type: "event", name: "input" },
      { type: "data", data: "." },
      { type: "event", name: "keydown", keyCode: 229 },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", [".", "."])],
  },
  {
    name: "does not deduplicate terminal control responses",
    steps: [
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "\u001b[1;1R" },
      { type: "data", data: "\u001b[1;1R" },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", ["\u001b[1;1R", "\u001b[1;1R"])],
  },
  {
    name: "allows matching data after the native correlation window",
    steps: [
      { type: "event", name: "keydown", keyCode: 190 },
      { type: "data", data: "." },
      { type: "advance", ms: 101 },
      { type: "data", data: "." },
    ],
    assert: [hasObserved<ResidueContext, undefined>("acceptedData", [".", "."])],
  },
] satisfies readonly ScenarioCase<"default", ResidueStep, undefined, ResidueContext>[];

const residueTable: ScenarioTable<ResidueFixture, "default", ResidueStep, undefined, ResidueContext> = {
  defaultFixture: createResidueFixture,
  cases: residueCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      switch (step.type) {
        case "set-value":
          fixture.textarea.value = step.value;
          break;
        case "data":
          if (fixture.guard.acceptData(step.data)) fixture.acceptedData.push(step.data);
          break;
        case "event":
          dispatchInputEvent(fixture.textarea, step.name, step.keyCode);
          break;
        case "advance":
          fixture.advance(step.ms);
          break;
        case "run-timers":
          fixture.runTimers();
          break;
        case "snapshot":
          fixture.snapshots.push(fixture.textarea.value);
          break;
        case "dispose":
          fixture.guard.dispose();
          break;
      }
    }
  },
  observe: (fixture) => ({
    value: fixture.textarea.value,
    pendingTimerCount: fixture.pendingTimerCount(),
    acceptedData: [...fixture.acceptedData],
    snapshots: [...fixture.snapshots],
  }),
};

describe("terminal textarea residue guard", () => {
  runScenarioTable(it as unknown as TestRegistrar, residueTable);
});

function createResidueFixture(): { fixture: ResidueFixture; cleanup: () => void } {
  const textarea = Object.assign(new EventTarget(), { value: "" }) as HTMLTextAreaElement & EventTarget;
  const timers = new Map<number, () => void>();
  const acceptedData: string[] = [];
  const snapshots: string[] = [];
  let nextTimer = 1;
  let currentTime = 0;
  const guard = installTerminalTextareaResidueGuard(textarea, {
    eventSurface: textarea,
    now: () => currentTime,
    setTimeout: (callback) => {
      const handle = nextTimer++;
      timers.set(handle, callback);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
  });
  return {
    fixture: {
      textarea,
      guard,
      acceptedData,
      advance: (milliseconds) => {
        currentTime += milliseconds;
      },
      runTimers: () => {
        const pending = [...timers.entries()];
        timers.clear();
        for (const [, callback] of pending) callback();
      },
      pendingTimerCount: () => timers.size,
      snapshots,
    },
    cleanup: () => guard.dispose(),
  };
}

function dispatchInputEvent(target: EventTarget, type: string, keyCode?: number): void {
  const event = new Event(type);
  if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
  target.dispatchEvent(event);
}
