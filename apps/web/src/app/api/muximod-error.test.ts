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
  classifyMuximodError,
  MuximodApiError,
  type MuximodErrorCategory,
  muximodErrorDetails,
  muximodErrorMessage,
} from "./muximod-error.js";

type Input = { error: unknown };
type Result = { category: MuximodErrorCategory; message: string; details: string };
type Context = {};

const cases = [
  {
    name: "presents authentication expiry as a recoverable message",
    input: { error: new MuximodApiError("session is invalid", 401, "session_invalid", null) },
    assert: [
      returns<Context, Result>({
        category: "authentication",
        message: "Muximod authentication expired. Please retry.",
        details: "session is invalid (HTTP 401, code=session_invalid)",
      }),
    ],
  },
  {
    name: "presents challenge rate limiting without exposing protocol details",
    input: {
      error: new MuximodApiError("too many authentication challenges requested", 429, "challenge_rate_limited", null),
    },
    assert: [
      returns<Context, Result>({
        category: "rate_limited",
        message: "Muximod is temporarily rate limiting requests. Please wait a moment and try again.",
        details: "too many authentication challenges requested (HTTP 429, code=challenge_rate_limited)",
      }),
    ],
  },
  {
    name: "preserves a server error message for diagnosis",
    input: { error: new MuximodApiError("muximod is unavailable", 503, "service_unavailable", null) },
    assert: [
      returns<Context, Result>({
        category: "server",
        message: "muximod is unavailable",
        details: "muximod is unavailable (HTTP 503, code=service_unavailable)",
      }),
    ],
  },
  {
    name: "classifies a native fetch failure as a network error",
    input: { error: Object.assign(new Error("Load failed"), { name: "TypeError" }) },
    assert: [
      returns<Context, Result>({ category: "network", message: "Load failed", details: "TypeError: Load failed" }),
    ],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<undefined, "default", Input, Result, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => ({
    category: classifyMuximodError(input.error),
    message: muximodErrorMessage(input.error),
    details: muximodErrorDetails(input.error),
  }),
  observe: () => ({}),
};

describe("muximod error classification", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
