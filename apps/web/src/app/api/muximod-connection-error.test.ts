import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { formatMuximodConnectionError, type MuximodRequestStage } from "./muximod-connection-error";

type Input = { stage: MuximodRequestStage; endpoint: string; cause: unknown };
type Context = {};

const cases = [
  {
    name: "shows the endpoint and native network failure",
    input: {
      stage: "requesting server information",
      endpoint: "https://muximo-host.example:8444",
      cause: Object.assign(new Error("Load failed"), { name: "TypeError" }),
    },
    assert: [
      returns<Context, string>(
        "Could not communicate with muximod while requesting server information.\nEndpoint: https://muximo-host.example:8444\nDetails: TypeError: Load failed (HTTP status unavailable: the browser did not expose a response; check CORS, TLS, or network connectivity)",
      ),
    ],
  },
  {
    name: "shows the server status and error code",
    input: {
      stage: "claiming the QR pairing",
      endpoint: "https://muximo-host.example:8444",
      cause: { message: "pairing was not found", status: 404, code: "pairing_not_found" },
    },
    assert: [
      returns<Context, string>(
        "Muximod returned an error while claiming the QR pairing.\nEndpoint: https://muximo-host.example:8444\nDetails: pairing was not found (HTTP 404, code=pairing_not_found)",
      ),
    ],
  },
  {
    name: "removes credentials and query values from the endpoint",
    input: {
      stage: "checking pairing approval",
      endpoint: "https://user:secret@muximo-host.example:8444/rpc?token=private",
      cause: new Error("The request timed out"),
    },
    assert: [
      returns<Context, string>(
        "Could not communicate with muximod while checking pairing approval.\nEndpoint: https://muximo-host.example:8444/rpc\nDetails: Error: The request timed out",
      ),
    ],
  },
] satisfies readonly OperationCase<"default", Input, string, Context>[];

const table: OperationTable<undefined, "default", Input, string, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => formatMuximodConnectionError(input.stage, input.endpoint, input.cause),
  observe: () => ({}),
};

describe("muximod connection error formatting", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
