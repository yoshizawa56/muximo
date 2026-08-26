import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { MuximodApiError } from "./muximod-error.js";
import {
  muximodEventReconnectDelay,
  muximodRetryDelay,
  shouldReconnectMuximodEvents,
  shouldRetryMuximodQuery,
} from "./muximod-retry-policy.js";

type RetryInput = { failureCount: number; error: unknown };
type Context = {};

const apiError = (status: number, code: string | null = null): MuximodApiError =>
  new MuximodApiError("request failed", status, code, null);

const retryCases = [
  {
    name: "does not retry authentication challenge rate limits",
    input: { failureCount: 0, error: apiError(429, "challenge_rate_limited") },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not retry ordinary client errors",
    input: { failureCount: 0, error: apiError(400, "invalid_input") },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "retries an expired authentication session once",
    input: { failureCount: 0, error: apiError(401, "session_invalid") },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "stops retrying an expired authentication session after one retry",
    input: { failureCount: 1, error: apiError(401, "session_invalid") },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "retries a server failure up to the transient limit",
    input: { failureCount: 1, error: apiError(503, "service_unavailable") },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "stops retrying a server failure at the transient limit",
    input: { failureCount: 2, error: apiError(503, "service_unavailable") },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "retries a native network failure",
    input: { failureCount: 0, error: Object.assign(new Error("Load failed"), { name: "TypeError" }) },
    assert: [returns<Context, boolean>(true)],
  },
] satisfies readonly OperationCase<"default", RetryInput, boolean, Context>[];

const retryTable: OperationTable<undefined, "default", RetryInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: retryCases,
  execute: (_fixture, input) => shouldRetryMuximodQuery(input.failureCount, input.error),
  observe: () => ({}),
};

type DelayInput = { attemptIndex: number };
const delayCases = [
  { name: "starts with a one second delay", input: { attemptIndex: 0 }, assert: [returns<Context, number>(1_000)] },
  { name: "backs off exponentially", input: { attemptIndex: 2 }, assert: [returns<Context, number>(4_000)] },
  { name: "caps the delay", input: { attemptIndex: 8 }, assert: [returns<Context, number>(30_000)] },
] satisfies readonly OperationCase<"default", DelayInput, number, Context>[];

const delayTable: OperationTable<undefined, "default", DelayInput, number, Context> = {
  defaultFixture: noFixture(),
  cases: delayCases,
  execute: (_fixture, input) => muximodRetryDelay(input.attemptIndex),
  observe: () => ({}),
};

type EventReconnectInput = { error: unknown; attemptIndex: number };
type EventReconnectResult = { reconnect: boolean; delay: number };
const eventReconnectCases = [
  {
    name: "waits out the authentication rate limit window before reconnecting",
    input: { error: apiError(429, "challenge_rate_limited"), attemptIndex: 0 },
    assert: [returns<Context, EventReconnectResult>({ reconnect: true, delay: 60_000 })],
  },
  {
    name: "does not reconnect a permanently unsupported event endpoint",
    input: { error: apiError(404, "not_found"), attemptIndex: 0 },
    assert: [returns<Context, EventReconnectResult>({ reconnect: false, delay: 1_000 })],
  },
] satisfies readonly OperationCase<"default", EventReconnectInput, EventReconnectResult, Context>[];

const eventReconnectTable: OperationTable<undefined, "default", EventReconnectInput, EventReconnectResult, Context> = {
  defaultFixture: noFixture(),
  cases: eventReconnectCases,
  execute: (_fixture, input) => ({
    reconnect: shouldReconnectMuximodEvents(input.error),
    delay: muximodEventReconnectDelay(input.attemptIndex, input.error),
  }),
  observe: () => ({}),
};

describe("muximod query retry policy", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, retryTable);
  runOperationTable(register, delayTable);
  runOperationTable(register, eventReconnectTable);
});
