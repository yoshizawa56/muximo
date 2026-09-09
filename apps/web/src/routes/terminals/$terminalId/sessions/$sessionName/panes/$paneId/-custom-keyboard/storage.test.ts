import type { GetOptions, SetOptions } from "@capacitor/preferences";
import {
  type FixtureHandle,
  hasObserved,
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
  CUSTOM_KEYBOARD_STORAGE_KEY,
  type CustomKeyboardStorage,
  createCustomKeyboardStorage,
  createSerializedCustomKeyboardStorage,
} from "./storage";

type BrowserStorage = {
  values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

type StorageFixture = {
  storage: CustomKeyboardStorage;
  preferenceGetKeys: string[];
  preferenceSetValues: string[];
  browserStorage: BrowserStorage;
};

type ReadContext = {
  preferenceGetKeys: readonly string[];
  preferenceSetValues: readonly string[];
  browserValue: string | null;
};

type WriteContext = {
  preferenceSetValues: readonly string[];
  browserValue: string | null;
};

function createStorageFixture(
  options: {
    preferenceValue?: string;
    browserValue?: string;
    failPreferenceGet?: boolean;
    failPreferenceSet?: boolean;
  } = {},
): FixtureHandle<StorageFixture> {
  const preferenceValues = new Map<string, string>();
  if (options.preferenceValue !== undefined) {
    preferenceValues.set(CUSTOM_KEYBOARD_STORAGE_KEY, options.preferenceValue);
  }
  const preferenceGetKeys: string[] = [];
  const preferenceSetValues: string[] = [];
  const browserValues = new Map<string, string>();
  if (options.browserValue !== undefined) {
    browserValues.set(CUSTOM_KEYBOARD_STORAGE_KEY, options.browserValue);
  }
  const browserStorage: BrowserStorage = {
    values: browserValues,
    getItem: (key) => browserValues.get(key) ?? null,
    setItem: (key, value) => browserValues.set(key, value),
  };
  const preferences = {
    get: async ({ key }: GetOptions) => {
      preferenceGetKeys.push(key);
      if (options.failPreferenceGet) throw new Error("preferences get unavailable");
      return { value: preferenceValues.get(key) ?? null };
    },
    set: async ({ key, value }: SetOptions) => {
      if (options.failPreferenceSet) throw new Error("preferences set unavailable");
      preferenceValues.set(key, value);
      preferenceSetValues.push(value);
    },
  };

  return {
    fixture: {
      storage: createCustomKeyboardStorage(preferences, browserStorage),
      preferenceGetKeys,
      preferenceSetValues,
      browserStorage,
    },
  };
}

type ReadFixtureKey = "preferences" | "browser" | "browser-fallback" | "empty";
const readCases = [
  {
    name: "reads the current Preferences value without reading browser storage",
    fixture: "preferences",
    input: {},
    assert: [
      returns<ReadContext, string | null>("preference-value"),
      hasObserved<ReadContext, string | null>("preferenceGetKeys", [CUSTOM_KEYBOARD_STORAGE_KEY]),
      hasObserved<ReadContext, string | null>("preferenceSetValues", []),
      hasObserved<ReadContext, string | null>("browserValue", "browser-value"),
    ],
  },
  {
    name: "reads the current browser value when Preferences is empty",
    fixture: "browser",
    input: {},
    assert: [
      returns<ReadContext, string | null>("browser-value"),
      hasObserved<ReadContext, string | null>("preferenceGetKeys", [CUSTOM_KEYBOARD_STORAGE_KEY]),
      hasObserved<ReadContext, string | null>("preferenceSetValues", []),
    ],
  },
  {
    name: "reads the current browser value when Preferences is unavailable",
    fixture: "browser-fallback",
    input: {},
    assert: [
      returns<ReadContext, string | null>("browser-value"),
      hasObserved<ReadContext, string | null>("preferenceGetKeys", [CUSTOM_KEYBOARD_STORAGE_KEY]),
      hasObserved<ReadContext, string | null>("preferenceSetValues", []),
    ],
  },
  {
    name: "returns null when neither storage has a value",
    fixture: "empty",
    input: {},
    assert: [returns<ReadContext, string | null>(null)],
  },
] satisfies readonly OperationCase<ReadFixtureKey, {}, string | null, ReadContext>[];

const readTable: OperationTable<StorageFixture, ReadFixtureKey, {}, string | null, ReadContext> = {
  defaultFixture: () => createStorageFixture(),
  fixtures: {
    preferences: () => createStorageFixture({ preferenceValue: "preference-value", browserValue: "browser-value" }),
    browser: () => createStorageFixture({ browserValue: "browser-value" }),
    "browser-fallback": () => createStorageFixture({ browserValue: "browser-value", failPreferenceGet: true }),
    empty: () => createStorageFixture(),
  },
  cases: readCases,
  execute: (fixture) => fixture.storage.read(),
  observe: (fixture) => ({
    preferenceGetKeys: fixture.preferenceGetKeys,
    preferenceSetValues: fixture.preferenceSetValues,
    browserValue: fixture.browserStorage.getItem(CUSTOM_KEYBOARD_STORAGE_KEY),
  }),
};

type WriteFixtureKey = "preferences" | "browser-fallback";
const writeCases = [
  {
    name: "writes through Preferences",
    fixture: "preferences",
    input: { value: "serialized-keyboard-state" },
    assert: [
      returns<WriteContext, void>(undefined),
      hasObserved<WriteContext, void>("preferenceSetValues", ["serialized-keyboard-state"]),
      hasObserved<WriteContext, void>("browserValue", null),
    ],
  },
  {
    name: "falls back to browser storage when Preferences is unavailable",
    fixture: "browser-fallback",
    input: { value: "serialized-keyboard-state" },
    assert: [
      returns<WriteContext, void>(undefined),
      hasObserved<WriteContext, void>("preferenceSetValues", []),
      hasObserved<WriteContext, void>("browserValue", "serialized-keyboard-state"),
    ],
  },
] satisfies readonly OperationCase<WriteFixtureKey, { value: string }, void, WriteContext>[];

const writeTable: OperationTable<StorageFixture, WriteFixtureKey, { value: string }, void, WriteContext> = {
  defaultFixture: () => createStorageFixture(),
  fixtures: {
    preferences: () => createStorageFixture(),
    "browser-fallback": () => createStorageFixture({ failPreferenceSet: true }),
  },
  cases: writeCases,
  execute: (fixture, input) => fixture.storage.write(input.value),
  observe: (fixture) => ({
    preferenceSetValues: fixture.preferenceSetValues,
    browserValue: fixture.browserStorage.getItem(CUSTOM_KEYBOARD_STORAGE_KEY),
  }),
};

type SerializedWriteFixture = {
  firstStorage: CustomKeyboardStorage;
  secondStorage: CustomKeyboardStorage;
  started: string[];
  completed: string[];
  persisted: string | null;
  pending: Array<() => void>;
  completions: Promise<void>[];
};

function createSerializedWriteFixture(): FixtureHandle<SerializedWriteFixture> {
  const started: string[] = [];
  const completed: string[] = [];
  let fixture: SerializedWriteFixture;
  const pending: Array<() => void> = [];
  const baseStorage: CustomKeyboardStorage = {
    read: async () => null,
    write: async (value) => {
      started.push(value);
      await new Promise<void>((resolve) => pending.push(resolve));
      fixture.persisted = value;
      completed.push(value);
    },
  };
  fixture = {
    firstStorage: createSerializedCustomKeyboardStorage(baseStorage),
    secondStorage: createSerializedCustomKeyboardStorage(baseStorage),
    started,
    completed,
    persisted: null,
    pending,
    completions: [],
  };
  return {
    fixture,
  };
}

type SerializedWriteStep =
  | { type: "write"; mount: "first" | "second"; value: string }
  | { type: "resolve-latest" }
  | { type: "resolve-next" };
type SerializedWriteContext = {
  started: readonly string[];
  completed: readonly string[];
  persisted: string | null;
};

async function resolvePendingWrite(fixture: { pending: Array<() => void> }, latest: boolean): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const resolver = latest ? fixture.pending.pop() : fixture.pending.shift();
    if (resolver) {
      resolver();
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for serialized storage write");
}

const serializedWriteCases = [
  {
    name: "serializes writes from separate mounts through one shared queue",
    steps: [
      { type: "write", mount: "first", value: "first" },
      { type: "write", mount: "second", value: "second" },
      { type: "resolve-latest" },
      { type: "resolve-next" },
    ],
    assert: [
      hasObserved<SerializedWriteContext, undefined>("started", ["first", "second"]),
      hasObserved<SerializedWriteContext, undefined>("completed", ["first", "second"]),
      hasObserved<SerializedWriteContext, undefined>("persisted", "second"),
    ],
  },
] satisfies readonly ScenarioCase<"default", SerializedWriteStep, undefined, SerializedWriteContext>[];

const serializedWriteTable: ScenarioTable<
  SerializedWriteFixture,
  "default",
  SerializedWriteStep,
  undefined,
  SerializedWriteContext
> = {
  defaultFixture: createSerializedWriteFixture,
  cases: serializedWriteCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "write") {
        const storage = step.mount === "first" ? fixture.firstStorage : fixture.secondStorage;
        fixture.completions.push(storage.write(step.value));
      } else await resolvePendingWrite(fixture, step.type === "resolve-latest");
    }
    await Promise.all(fixture.completions);
  },
  observe: (fixture) => ({ started: fixture.started, completed: fixture.completed, persisted: fixture.persisted }),
};

type SerializedHydrationFixture = {
  firstStorage: CustomKeyboardStorage;
  secondStorage: CustomKeyboardStorage;
  persisted: string;
  pending: Array<() => void>;
  reads: string[];
  operations: Promise<void>[];
};

function createSerializedHydrationFixture(): FixtureHandle<SerializedHydrationFixture> {
  let fixture: SerializedHydrationFixture;
  const pending: Array<() => void> = [];
  const baseStorage: CustomKeyboardStorage = {
    read: async () => fixture.persisted,
    write: async (value) => {
      await new Promise<void>((resolve) => pending.push(resolve));
      fixture.persisted = value;
    },
  };
  fixture = {
    firstStorage: createSerializedCustomKeyboardStorage(baseStorage),
    secondStorage: createSerializedCustomKeyboardStorage(baseStorage),
    persisted: "baseline",
    pending,
    reads: [],
    operations: [],
  };
  return { fixture };
}

type SerializedHydrationStep =
  | { type: "write"; mount: "first" | "second"; value: string }
  | { type: "read"; mount: "first" | "second" }
  | { type: "resolve-latest" }
  | { type: "resolve-next" };
type SerializedHydrationContext = { reads: readonly string[]; persisted: string };

const serializedHydrationCases = [
  {
    name: "waits for queued writes before hydrating a remounted storage reader",
    steps: [
      { type: "write", mount: "first", value: "old" },
      { type: "read", mount: "second" },
      { type: "write", mount: "second", value: "new" },
      { type: "resolve-latest" },
      { type: "resolve-next" },
    ],
    assert: [
      hasObserved<SerializedHydrationContext, undefined>("reads", ["new"]),
      hasObserved<SerializedHydrationContext, undefined>("persisted", "new"),
    ],
  },
] satisfies readonly ScenarioCase<"default", SerializedHydrationStep, undefined, SerializedHydrationContext>[];

const serializedHydrationTable: ScenarioTable<
  SerializedHydrationFixture,
  "default",
  SerializedHydrationStep,
  undefined,
  SerializedHydrationContext
> = {
  defaultFixture: createSerializedHydrationFixture,
  cases: serializedHydrationCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "write") {
        const storage = step.mount === "first" ? fixture.firstStorage : fixture.secondStorage;
        fixture.operations.push(storage.write(step.value));
      }
      if (step.type === "read") {
        const storage = step.mount === "first" ? fixture.firstStorage : fixture.secondStorage;
        fixture.operations.push(
          storage.read().then((value) => {
            fixture.reads.push(value ?? "");
          }),
        );
      }
      if (step.type === "resolve-latest") await resolvePendingWrite(fixture, true);
      if (step.type === "resolve-next") await resolvePendingWrite(fixture, false);
    }
    await Promise.all(fixture.operations);
  },
  observe: (fixture) => ({ reads: fixture.reads, persisted: fixture.persisted }),
};

describe("custom keyboard storage", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, readTable);
  runOperationTable(register, writeTable);
  runScenarioTable(register, serializedWriteTable);
  runScenarioTable(register, serializedHydrationTable);
});
