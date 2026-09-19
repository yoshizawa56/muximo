import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type PaneLayoutQueryStatusInput,
  paneLayoutMaxRefreshes,
  paneLayoutQueryRetryDelay,
  paneLayoutQueryStatus,
} from "./-pane-layout-policy";

type Context = {};

const statusCases = [
  {
    name: "shows loading while the first snapshot is pending",
    input: {
      paneCount: 0,
      completeLayout: false,
      queryPending: true,
      queryError: false,
      queryFetching: true,
      refreshAttempts: 0,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("loading")],
  },
  {
    name: "shows loading while an incomplete snapshot can still refresh",
    input: {
      paneCount: 2,
      completeLayout: false,
      queryPending: false,
      queryError: false,
      queryFetching: false,
      refreshAttempts: paneLayoutMaxRefreshes - 1,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("loading")],
  },
  {
    name: "shows loading while the final incomplete refresh is in flight",
    input: {
      paneCount: 2,
      completeLayout: false,
      queryPending: false,
      queryError: false,
      queryFetching: true,
      refreshAttempts: paneLayoutMaxRefreshes,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("loading")],
  },
  {
    name: "shows an error after incomplete refreshes are exhausted",
    input: {
      paneCount: 2,
      completeLayout: false,
      queryPending: false,
      queryError: false,
      queryFetching: false,
      refreshAttempts: paneLayoutMaxRefreshes,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("error")],
  },
  {
    name: "shows an error when a background refetch fails with cached data",
    input: {
      paneCount: 2,
      completeLayout: true,
      queryPending: false,
      queryError: true,
      queryFetching: false,
      refreshAttempts: 0,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("error")],
  },
  {
    name: "shows ready for a complete snapshot",
    input: {
      paneCount: 2,
      completeLayout: true,
      queryPending: false,
      queryError: false,
      queryFetching: false,
      refreshAttempts: 0,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("ready")],
  },
  {
    name: "shows ready for an empty successful snapshot",
    input: {
      paneCount: 0,
      completeLayout: true,
      queryPending: false,
      queryError: false,
      queryFetching: false,
      refreshAttempts: 0,
    },
    assert: [returns<Context, ReturnType<typeof paneLayoutQueryStatus>>("ready")],
  },
] satisfies readonly OperationCase<
  "default",
  PaneLayoutQueryStatusInput,
  ReturnType<typeof paneLayoutQueryStatus>,
  Context
>[];

const statusTable: OperationTable<
  undefined,
  "default",
  PaneLayoutQueryStatusInput,
  ReturnType<typeof paneLayoutQueryStatus>,
  Context
> = {
  defaultFixture: noFixture(),
  cases: statusCases,
  execute: (_fixture, input) => paneLayoutQueryStatus(input),
  observe: () => ({}),
};

type RetryDelayInput = { attempt: number };
const retryDelayCases = [
  { name: "uses the base delay for the first retry", input: { attempt: 0 }, assert: [returns<Context, number>(50)] },
  { name: "backs off the second retry", input: { attempt: 1 }, assert: [returns<Context, number>(100)] },
  { name: "caps later retry delays", input: { attempt: 4 }, assert: [returns<Context, number>(250)] },
] satisfies readonly OperationCase<"default", RetryDelayInput, number, Context>[];

const retryDelayTable: OperationTable<undefined, "default", RetryDelayInput, number, Context> = {
  defaultFixture: noFixture(),
  cases: retryDelayCases,
  execute: (_fixture, input) => paneLayoutQueryRetryDelay(input.attempt),
  observe: () => ({}),
};

describe("pane layout query policy", () => {
  runOperationTable(it as unknown as TestRegistrar, statusTable);
  runOperationTable(it as unknown as TestRegistrar, retryDelayTable);
});
