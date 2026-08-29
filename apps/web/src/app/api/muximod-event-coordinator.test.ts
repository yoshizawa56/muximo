import type { MuximodEvent } from "@muximo/contract/api";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { QueryClient } from "@tanstack/react-query";
import { describe, it } from "vitest";
import {
  createMuximodEventCoordinator,
  type MuximodEventCoordinatorOptions,
  type MuximodEventSubscriber,
} from "./muximod-event-coordinator.js";
import { muximodQueryUtils } from "./orpc-utils.js";

type CoordinatorFixture = {
  coordinator: ReturnType<typeof createMuximodEventCoordinator>;
  subscriber: MuximodEventSubscriber;
  openCalls: number;
  consumeCalls: number;
  stopCalls: number;
  cleanups: Array<() => void>;
};
type Input = { subscriberCount: number; unsubscribeDuringExecution: boolean };
type Result = { openCalls: number; consumeCalls: number; stopCalls: number };
type Context = { openCalls: number; consumeCalls: number; stopCalls: number };

const eventIterator = () =>
  ({
    next: async () => ({ done: true, value: undefined }),
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  }) as AsyncIteratorObject<MuximodEvent>;

const coordinatorFixture = (): FixtureHandle<CoordinatorFixture> => {
  const connection = {
    route: "serve" as const,
    httpBaseUrl: "http://muximod.local",
    websocketUrl: "ws://muximod.local/terminal",
  };
  const utils = muximodQueryUtils(connection);
  const queryClient = { invalidateQueries: async () => undefined } as unknown as QueryClient;
  let openCalls = 0;
  let consumeCalls = 0;
  let stopCalls = 0;
  const cleanups: Array<() => void> = [];
  const options: MuximodEventCoordinatorOptions = {
    open: async () => {
      openCalls += 1;
      return eventIterator();
    },
    consume: (_iterator, _handlers) => {
      consumeCalls += 1;
      return async () => {
        stopCalls += 1;
      };
    },
  };
  const coordinator = createMuximodEventCoordinator(options);
  return {
    fixture: {
      coordinator,
      subscriber: { queryClient, utils },
      get openCalls() {
        return openCalls;
      },
      get consumeCalls() {
        return consumeCalls;
      },
      get stopCalls() {
        return stopCalls;
      },
      cleanups,
    },
    cleanup: () => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
};

const cases = [
  {
    name: "shares one stream across concurrent view model subscribers",
    input: { subscriberCount: 4, unsubscribeDuringExecution: false },
    assert: [
      returns<Context, Result>({ openCalls: 1, consumeCalls: 1, stopCalls: 0 }),
      hasObserved<Context, Result>("openCalls", 1),
    ],
  },
  {
    name: "stops the shared stream after the last subscriber leaves",
    input: { subscriberCount: 2, unsubscribeDuringExecution: true },
    assert: [returns<Context, Result>({ openCalls: 1, consumeCalls: 1, stopCalls: 1 })],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<CoordinatorFixture, "default", Input, Result, Context> = {
  defaultFixture: coordinatorFixture,
  cases,
  execute: async (fixture, input) => {
    for (let index = 0; index < input.subscriberCount; index += 1) {
      const unsubscribe = fixture.coordinator.subscribe({ ...fixture.subscriber });
      fixture.cleanups.push(unsubscribe);
    }
    await Promise.resolve();
    await Promise.resolve();
    if (input.unsubscribeDuringExecution) {
      for (const cleanup of fixture.cleanups.splice(0).reverse()) cleanup();
    }
    return {
      openCalls: fixture.openCalls,
      consumeCalls: fixture.consumeCalls,
      stopCalls: fixture.stopCalls,
    };
  },
  observe: (fixture) => ({
    openCalls: fixture.openCalls,
    consumeCalls: fixture.consumeCalls,
    stopCalls: fixture.stopCalls,
  }),
};

describe("muximod event coordination", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
