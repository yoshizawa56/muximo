import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createOriginPolicy } from "./middleware.js";

const runtimeOrigin = "https://machine.tailnet.ts.net:8444";

type OriginPolicyInput = { operation: "register" | "clear" };
type OriginPolicyFixture = {
  policy: ReturnType<typeof createOriginPolicy>;
  allowed: boolean[];
};
type OriginPolicyContext = { allowed: readonly boolean[] };

const cases = [
  {
    name: "allows the registered external Serve origin",
    input: { operation: "register" },
    assert: [hasObserved<OriginPolicyContext, undefined>("allowed", [true])],
  },
  {
    name: "removes the external Serve origin when it is cleared",
    input: { operation: "clear" },
    assert: [hasObserved<OriginPolicyContext, undefined>("allowed", [false])],
  },
] satisfies readonly OperationCase<"default", OriginPolicyInput, undefined, OriginPolicyContext>[];

const table: OperationTable<OriginPolicyFixture, "default", OriginPolicyInput, undefined, OriginPolicyContext> = {
  defaultFixture: () => ({
    fixture: {
      policy: createOriginPolicy({ allowedOrigins: [], allowNoOrigin: false }),
      allowed: [],
    },
  }),
  cases,
  execute: (fixture, input) => {
    fixture.policy.setRuntimeOrigin(runtimeOrigin);
    if (input.operation === "clear") fixture.policy.setRuntimeOrigin(null);
    fixture.allowed.push(
      fixture.policy.allowsRequest?.(new Request("http://127.0.0.1/rpc", { headers: { origin: runtimeOrigin } })) ??
        false,
    );
  },
  observe: (fixture) => ({ allowed: [...fixture.allowed] }),
};

describe("muximod origin policy runtime Serve origin", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
