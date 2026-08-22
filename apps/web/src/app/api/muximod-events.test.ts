import { describe, it } from "vitest";
import { muximodEventSchema } from "@muximo/contract";
import {
  noFixture,
  returns,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { invalidateOnMuximodEvent } from "./invalidation.js";
import { muximodQueryUtils } from "./orpc-utils.js";

const connection = {
  route: "serve" as const,
  httpBaseUrl: "http://muximod.local",
  websocketUrl: "ws://muximod.local/terminal",
};

type InvalidatingClient = {
  invalidateQueries(options: { queryKey?: unknown }): Promise<void>;
};

type QueryStub = {
  client: InvalidatingClient;
  invalidated: unknown[];
};

const queryStubFixture = (): FixtureHandle<QueryStub> => {
  const invalidated: unknown[] = [];
  return {
    fixture: {
      invalidated,
      client: {
        invalidateQueries: async (options) => {
          invalidated.push(options.queryKey);
        },
      },
    },
    cleanup: () => {},
  };
};

type Input = { event: ReturnType<typeof muximodEventSchema.parse> };
type Result = readonly unknown[];
type Context = {};

const cases = [
  {
    name: "invalidates every sessions-derived cache region through contract subtree keys",
    input: {
      event: muximodEventSchema.parse({
        type: "session_updated",
        sessionName: "work",
        reason: "pane_created",
        revision: 4,
      }),
    },
    assert: [
      returns<Context, Result>([
        [["muximod", "serve:http://muximod.local", "sessions"], {}],
        [["muximod", "serve:http://muximod.local", "panes"], {}],
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<QueryStub, "default", Input, Result, Context> = {
  defaultFixture: queryStubFixture,
  cases,
  execute: (fixture, input) => {
    const utils = muximodQueryUtils(connection);
    void invalidateOnMuximodEvent(fixture.client as unknown as Parameters<typeof invalidateOnMuximodEvent>[0], utils, input.event);
    return [...fixture.invalidated];
  },
  observe: () => ({}),
};

describe("muximod event query invalidation", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
