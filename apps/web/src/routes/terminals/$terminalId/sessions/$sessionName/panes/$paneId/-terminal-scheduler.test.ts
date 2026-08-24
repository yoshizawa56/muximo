import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createTerminalInputBatcher, createTerminalOutputScheduler, type TerminalData } from "./-terminal-scheduler";

type ScheduledCallback = { id: number; callback: () => void; delayMs?: number };

type FakeScheduler = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
  runFrame: () => void;
  runTimer: (delayMs: number) => void;
  pendingFrameCount: () => number;
  pendingTimerDelays: () => readonly number[];
};

type OutputFixture = {
  output: string[];
  scheduler: FakeScheduler;
  terminal: ReturnType<typeof createTerminalOutputScheduler>;
};

type OutputStep =
  | { type: "write"; data: string }
  | { type: "mark-scroll" }
  | { type: "run-frame" }
  | { type: "run-timer"; delayMs: number };

type OutputContext = {
  output: readonly string[];
  pendingFrameCount: number;
  pendingTimerDelays: readonly number[];
};

const outputCases = [
  {
    name: "holds ordinary output for the normal render interval",
    steps: [{ type: "write", data: "agent output" }],
    assert: [
      hasObserved<OutputContext, undefined>("output", []),
      hasObserved<OutputContext, undefined>("pendingTimerDelays", [32]),
    ],
  },
  {
    name: "flushes all pending output on the next frame during scrolling",
    steps: [
      { type: "mark-scroll" },
      { type: "write", data: "first" },
      { type: "write", data: "second" },
      { type: "run-frame" },
    ],
    assert: [
      hasObserved<OutputContext, undefined>("output", ["first", "second"]),
      hasObserved<OutputContext, undefined>("pendingFrameCount", 0),
      hasObserved<OutputContext, undefined>("pendingTimerDelays", [140]),
    ],
  },
  {
    name: "returns to the normal interval after scrolling becomes idle",
    steps: [
      { type: "mark-scroll" },
      { type: "write", data: "scroll response" },
      { type: "run-frame" },
      { type: "run-timer", delayMs: 140 },
      { type: "write", data: "agent response" },
      { type: "run-timer", delayMs: 32 },
    ],
    assert: [
      hasObserved<OutputContext, undefined>("output", ["scroll response", "agent response"]),
      hasObserved<OutputContext, undefined>("pendingFrameCount", 0),
      hasObserved<OutputContext, undefined>("pendingTimerDelays", []),
    ],
  },
] satisfies readonly ScenarioCase<"default", OutputStep, undefined, OutputContext>[];

const outputTable: ScenarioTable<OutputFixture, "default", OutputStep, undefined, OutputContext> = {
  defaultFixture: createOutputFixture,
  cases: outputCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      switch (step.type) {
        case "write":
          fixture.terminal.write(step.data);
          break;
        case "mark-scroll":
          fixture.terminal.markScroll();
          break;
        case "run-frame":
          fixture.scheduler.runFrame();
          break;
        case "run-timer":
          fixture.scheduler.runTimer(step.delayMs);
          break;
      }
    }
  },
  observe: (fixture) => ({
    output: [...fixture.output],
    pendingFrameCount: fixture.scheduler.pendingFrameCount(),
    pendingTimerDelays: fixture.scheduler.pendingTimerDelays(),
  }),
};

type InputFixture = {
  inputs: string[];
  scheduler: FakeScheduler;
  batcher: ReturnType<typeof createTerminalInputBatcher>;
};

type InputStep = { type: "enqueue"; data: string } | { type: "flush" } | { type: "run-frame" };

type InputContext = {
  inputs: readonly string[];
  pendingFrameCount: number;
};

const inputCases = [
  {
    name: "coalesces wheel input until the next animation frame",
    steps: [
      { type: "enqueue", data: "wheel-up" },
      { type: "enqueue", data: "wheel-down" },
    ],
    assert: [
      hasObserved<InputContext, undefined>("inputs", []),
      hasObserved<InputContext, undefined>("pendingFrameCount", 1),
    ],
  },
  {
    name: "sends coalesced wheel input in order on the animation frame",
    steps: [{ type: "enqueue", data: "wheel-up" }, { type: "enqueue", data: "wheel-down" }, { type: "run-frame" }],
    assert: [
      hasObserved<InputContext, undefined>("inputs", ["wheel-upwheel-down"]),
      hasObserved<InputContext, undefined>("pendingFrameCount", 0),
    ],
  },
  {
    name: "flushes pending wheel input before an interactive input",
    steps: [{ type: "enqueue", data: "wheel-up" }, { type: "flush" }],
    assert: [
      hasObserved<InputContext, undefined>("inputs", ["wheel-up"]),
      hasObserved<InputContext, undefined>("pendingFrameCount", 0),
    ],
  },
] satisfies readonly ScenarioCase<"default", InputStep, undefined, InputContext>[];

const inputTable: ScenarioTable<InputFixture, "default", InputStep, undefined, InputContext> = {
  defaultFixture: createInputFixture,
  cases: inputCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      switch (step.type) {
        case "enqueue":
          fixture.batcher.enqueue(step.data);
          break;
        case "flush":
          fixture.batcher.flush();
          break;
        case "run-frame":
          fixture.scheduler.runFrame();
          break;
      }
    }
  },
  observe: (fixture) => ({
    inputs: [...fixture.inputs],
    pendingFrameCount: fixture.scheduler.pendingFrameCount(),
  }),
};

describe("terminal scheduling", () => {
  const register = it as unknown as TestRegistrar;
  runScenarioTable(register, outputTable);
  runScenarioTable(register, inputTable);
});

function createOutputFixture(): FixtureHandle<OutputFixture> {
  const scheduler = createFakeScheduler();
  const output: string[] = [];
  const terminal = createTerminalOutputScheduler({
    write: (data) => output.push(stringifyTerminalData(data)),
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  return {
    fixture: { output, scheduler, terminal },
    cleanup: () => terminal.dispose(),
  };
}

function createInputFixture(): FixtureHandle<InputFixture> {
  const scheduler = createFakeScheduler();
  const inputs: string[] = [];
  const batcher = createTerminalInputBatcher((data) => inputs.push(data), {
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
  });
  return {
    fixture: { inputs, scheduler, batcher },
    cleanup: () => batcher.dispose(),
  };
}

function createFakeScheduler(): FakeScheduler {
  let nextId = 1;
  const frames: ScheduledCallback[] = [];
  const timers: ScheduledCallback[] = [];

  const requestFrame = (callback: () => void): number => {
    const id = nextId++;
    frames.push({ id, callback });
    return id;
  };
  const cancelFrame = (handle: number): void => {
    const index = frames.findIndex((frame) => frame.id === handle);
    if (index >= 0) frames.splice(index, 1);
  };
  const setTimeout = (callback: () => void, delayMs: number): number => {
    const id = nextId++;
    timers.push({ id, callback, delayMs });
    return id;
  };
  const clearTimeout = (handle: number): void => {
    const index = timers.findIndex((timer) => timer.id === handle);
    if (index >= 0) timers.splice(index, 1);
  };

  return {
    requestFrame,
    cancelFrame,
    setTimeout,
    clearTimeout,
    runFrame: () => {
      const frame = frames.shift();
      if (!frame) throw new Error("No animation frame is pending");
      frame.callback();
    },
    runTimer: (delayMs) => {
      const index = timers.findIndex((timer) => timer.delayMs === delayMs);
      if (index < 0) throw new Error(`No timer is pending for ${delayMs}ms`);
      const [timer] = timers.splice(index, 1);
      timer!.callback();
    },
    pendingFrameCount: () => frames.length,
    pendingTimerDelays: () => timers.map((timer) => timer.delayMs ?? 0),
  };
}

function stringifyTerminalData(data: TerminalData): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}
