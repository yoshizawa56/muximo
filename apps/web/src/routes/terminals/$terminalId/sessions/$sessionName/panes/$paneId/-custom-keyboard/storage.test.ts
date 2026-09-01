import type { GetOptions, SetOptions } from "@capacitor/preferences";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { CUSTOM_KEYBOARD_STORAGE_KEY, type CustomKeyboardStorage, createCustomKeyboardStorage } from "./storage";

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

describe("custom keyboard storage", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, readTable);
  runOperationTable(register, writeTable);
});
