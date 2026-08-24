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
import { describe, it } from "vitest";
import { createMuximoBridge, type MuximoAppInfo, type MuximoBridge, muximoFallbackAppInfo } from "./muximo-bridge";

type BridgeContext = {
  platform: string;
  isNative: boolean;
  capabilities: MuximoBridge["capabilities"];
};

const bridgeCases = [
  {
    name: "uses the web platform with native-only capabilities disabled",
    input: {},
    assert: [
      hasObserved<BridgeContext, MuximoBridge>("platform", "web"),
      hasObserved<BridgeContext, MuximoBridge>("isNative", false),
      hasObserved<BridgeContext, MuximoBridge>("capabilities", {
        appLifecycle: true,
        routeProvider: false,
        keychain: false,
        notifications: false,
        liveActivities: false,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, MuximoBridge, BridgeContext>[];

const bridgeTable: OperationTable<undefined, "default", {}, MuximoBridge, BridgeContext> = {
  defaultFixture: noFixture(),
  cases: bridgeCases,
  execute: () => createMuximoBridge(),
  observe: (_fixture, result) => {
    if (!result.ok)
      return {
        platform: "",
        isNative: false,
        capabilities: {
          appLifecycle: true,
          routeProvider: false,
          keychain: false,
          notifications: false,
          liveActivities: false,
        },
      };
    return {
      platform: result.value.platform,
      isNative: result.value.isNative,
      capabilities: result.value.capabilities,
    };
  },
};

const appInfoCases = [
  {
    name: "returns the web package version outside a native app",
    input: {},
    assert: [returns<undefined, MuximoAppInfo>(muximoFallbackAppInfo)],
  },
] satisfies readonly OperationCase<"default", {}, MuximoAppInfo, undefined>[];

const appInfoTable: OperationTable<undefined, "default", {}, MuximoAppInfo, undefined> = {
  defaultFixture: noFixture(),
  cases: appInfoCases,
  execute: () => createMuximoBridge().getAppInfo(),
  observe: () => undefined,
};

type VisibilityStep =
  | { type: "set-visibility"; value: DocumentVisibilityState }
  | { type: "dispatch" }
  | { type: "unsubscribe" };
type VisibilityContext = { states: readonly string[] };
type VisibilityFixture = {
  documentStub: {
    visibilityState: DocumentVisibilityState;
    addEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => void;
    removeEventListener: (_eventName: string, listener: EventListenerOrEventListenerObject) => void;
    dispatchVisibilityChange: () => void;
  };
  states: string[];
  unsubscribe: (() => void) | null;
};

const visibilityFixture = (): FixtureHandle<VisibilityFixture> => {
  const originalDocument = globalThis.document;
  const listeners = new Set<() => void>();
  const documentStub: VisibilityFixture["documentStub"] = {
    visibilityState: "visible",
    addEventListener: (_eventName, listener) => listeners.add(listener as () => void),
    removeEventListener: (_eventName, listener) => listeners.delete(listener as () => void),
    dispatchVisibilityChange: () => {
      for (const listener of listeners) listener();
    },
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentStub });
  const fixture: VisibilityFixture = { documentStub, states: [], unsubscribe: null };
  const bridge = createMuximoBridge();
  fixture.unsubscribe = bridge.onAppStateChange((state) => fixture.states.push(state));
  return {
    fixture,
    cleanup: () => {
      fixture.unsubscribe?.();
      if (originalDocument)
        Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
};

const visibilityCases = [
  {
    name: "forwards visibility changes and stops after unsubscribe",
    steps: [
      { type: "set-visibility", value: "hidden" },
      { type: "dispatch" },
      { type: "set-visibility", value: "visible" },
      { type: "dispatch" },
      { type: "unsubscribe" },
      { type: "set-visibility", value: "hidden" },
      { type: "dispatch" },
    ],
    assert: [hasObserved<VisibilityContext, undefined>("states", ["background", "active"])],
  },
] satisfies readonly ScenarioCase<"default", VisibilityStep, undefined, VisibilityContext>[];

const visibilityTable: ScenarioTable<VisibilityFixture, "default", VisibilityStep, undefined, VisibilityContext> = {
  defaultFixture: visibilityFixture,
  cases: visibilityCases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "set-visibility") fixture.documentStub.visibilityState = step.value;
      if (step.type === "dispatch") fixture.documentStub.dispatchVisibilityChange();
      if (step.type === "unsubscribe") {
        fixture.unsubscribe?.();
        fixture.unsubscribe = null;
      }
    }
  },
  observe: (fixture) => ({ states: [...fixture.states] }),
};

describe("muximo bridge", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, bridgeTable);
  runOperationTable(register, appInfoTable);
  runScenarioTable(register, visibilityTable);
});
