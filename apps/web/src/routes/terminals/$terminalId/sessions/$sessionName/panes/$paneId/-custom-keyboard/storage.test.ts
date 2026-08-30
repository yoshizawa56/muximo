import type { GetOptions, RemoveOptions, SetOptions } from "@capacitor/preferences";
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
import {
  CUSTOM_KEYBOARD_STORAGE_KEY,
  type CustomKeyboardStorage,
  createCustomKeyboardStorage,
  LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY,
} from "./storage";

type LegacyStorage = {
  values: Map<string, string>;
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
};

type StorageFixture = {
  storage: CustomKeyboardStorage;
  preferenceValues: Map<string, string>;
  preferenceGetKeys: string[];
  preferenceSetValues: string[];
  legacyStorage: LegacyStorage;
  failPreferenceGet: boolean;
  failPreferenceSet: boolean;
};

type ReadContext = {
  preferenceGetKeys: readonly string[];
  preferenceSetValues: readonly string[];
  legacyValue: string | null;
};

type WriteContext = {
  preferenceSetValues: readonly string[];
  legacyValue: string | null;
};

function createStorageFixture(
  options: {
    preferenceValue?: string;
    legacyValue?: string;
    failPreferenceGet?: boolean;
    failPreferenceSet?: boolean;
  } = {},
): FixtureHandle<StorageFixture> {
  const preferenceValues = new Map<string, string>();
  if (options.preferenceValue !== undefined) preferenceValues.set(CUSTOM_KEYBOARD_STORAGE_KEY, options.preferenceValue);
  const preferenceGetKeys: string[] = [];
  const preferenceSetValues: string[] = [];
  const legacyValues = new Map<string, string>();
  if (options.legacyValue !== undefined) legacyValues.set(LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY, options.legacyValue);
  const legacyStorage: LegacyStorage = {
    values: legacyValues,
    getItem: (key) => legacyValues.get(key) ?? null,
    removeItem: (key) => legacyValues.delete(key),
    setItem: (key, value) => legacyValues.set(key, value),
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
    remove: async ({ key }: RemoveOptions) => {
      preferenceValues.delete(key);
    },
  };

  return {
    fixture: {
      storage: createCustomKeyboardStorage(preferences, legacyStorage),
      preferenceValues,
      preferenceGetKeys,
      preferenceSetValues,
      legacyStorage,
      failPreferenceGet: options.failPreferenceGet ?? false,
      failPreferenceSet: options.failPreferenceSet ?? false,
    },
  };
}

type ReadFixtureKey = "current" | "legacy" | "empty";
const readCases = [
  {
    name: "reads the current Preferences value without touching legacy storage",
    fixture: "current",
    input: {},
    assert: [
      returns<ReadContext, string | null>("current-value"),
      hasObserved<ReadContext, string | null>("preferenceGetKeys", [CUSTOM_KEYBOARD_STORAGE_KEY]),
      hasObserved<ReadContext, string | null>("preferenceSetValues", []),
      hasObserved<ReadContext, string | null>("legacyValue", "legacy-value"),
    ],
  },
  {
    name: "migrates the legacy value into Preferences",
    fixture: "legacy",
    input: {},
    assert: [
      returns<ReadContext, string | null>("legacy-value"),
      hasObserved<ReadContext, string | null>("preferenceSetValues", ["legacy-value"]),
      hasObserved<ReadContext, string | null>("legacyValue", null),
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
    current: () => createStorageFixture({ preferenceValue: "current-value", legacyValue: "legacy-value" }),
    legacy: () => createStorageFixture({ legacyValue: "legacy-value" }),
    empty: () => createStorageFixture(),
  },
  cases: readCases,
  execute: (fixture) => fixture.storage.read(),
  observe: (fixture) => ({
    preferenceGetKeys: fixture.preferenceGetKeys,
    preferenceSetValues: fixture.preferenceSetValues,
    legacyValue: fixture.legacyStorage.getItem(LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY),
  }),
};

type WriteFixtureKey = "preferences" | "legacy-fallback";
const writeCases = [
  {
    name: "writes through Preferences",
    fixture: "preferences",
    input: { value: "serialized-keyboard-state" },
    assert: [
      returns<WriteContext, void>(undefined),
      hasObserved<WriteContext, void>("preferenceSetValues", ["serialized-keyboard-state"]),
      hasObserved<WriteContext, void>("legacyValue", null),
    ],
  },
  {
    name: "falls back to legacy storage when Preferences is unavailable",
    fixture: "legacy-fallback",
    input: { value: "serialized-keyboard-state" },
    assert: [
      returns<WriteContext, void>(undefined),
      hasObserved<WriteContext, void>("preferenceSetValues", []),
      hasObserved<WriteContext, void>("legacyValue", "serialized-keyboard-state"),
    ],
  },
] satisfies readonly OperationCase<WriteFixtureKey, { value: string }, void, WriteContext>[];

const writeTable: OperationTable<StorageFixture, WriteFixtureKey, { value: string }, void, WriteContext> = {
  defaultFixture: () => createStorageFixture(),
  fixtures: {
    preferences: () => createStorageFixture(),
    "legacy-fallback": () => createStorageFixture({ failPreferenceSet: true }),
  },
  cases: writeCases,
  execute: (fixture, input) => fixture.storage.write(input.value),
  observe: (fixture) => ({
    preferenceSetValues: fixture.preferenceSetValues,
    legacyValue: fixture.legacyStorage.getItem(CUSTOM_KEYBOARD_STORAGE_KEY),
  }),
};

describe("custom keyboard storage", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, readTable);
  runOperationTable(register, writeTable);
});
