import { describe, it } from "vitest";
import { hasError, hasNoError, hasObserved, returns } from "./assertions.js";
import {
  type Assertion,
  assertAll,
  type OperationCase,
  type OperationTable,
  type Outcome,
  runOperationTable,
  TableAssertionError,
  TableCleanupError,
  type TestRegistrar,
} from "./table.js";

type FixtureKey = "override";

type Fixture = {
  label: string;
  value: string;
  error?: { code: string };
};

type Context = {
  label: string;
  outcome: Outcome<string>;
  assertionFailureNames?: string[];
  assertionMessage?: string;
};

type AggregateContext = {
  label: string;
  outcome: Outcome<TableAssertionError>;
  assertionFailureNames: string[];
  assertionMessage: string;
};

describe("operation table support", () => {
  const register = it as unknown as TestRegistrar;

  const defaultCases = [
    {
      name: "uses the lazy default fixture",
      input: {},
      assert: [
        hasNoError<Context, string>(),
        returns<Context, string>("default"),
        hasObserved<Context, string>("label", "default"),
      ],
    },
  ] satisfies readonly OperationCase<FixtureKey, {}, string, Context>[];

  const defaultTable: OperationTable<Fixture, FixtureKey, {}, string, Context> = {
    defaultFixture: async () => ({
      fixture: { label: "default", value: "default" },
    }),
    cases: defaultCases,
    execute: (fixture) => fixture.value,
    observe: (fixture, outcome) => ({
      label: fixture.label,
      outcome,
    }),
  };

  runOperationTable(register, defaultTable);

  const overrideCases = [
    {
      name: "uses only the selected fixture",
      fixture: "override" as const,
      input: {},
      assert: [returns<Context, string>("override")],
    },
  ] satisfies readonly OperationCase<FixtureKey, {}, string, Context>[];

  const overrideTable: OperationTable<Fixture, FixtureKey, {}, string, Context> = {
    defaultFixture: async () => {
      throw new Error("the default fixture must not be evaluated");
    },
    fixtures: {
      override: async () => ({
        fixture: { label: "override", value: "override" },
      }),
    },
    cases: overrideCases,
    execute: (fixture) => fixture.value,
    observe: (fixture, outcome) => ({
      label: fixture.label,
      outcome,
    }),
  };

  runOperationTable(register, overrideTable);

  const errorCases = [
    {
      name: "captures an error from execute as an outcome",
      input: {},
      assert: [hasError<Context, string>({ code: "domain_error" })],
    },
  ] satisfies readonly OperationCase<FixtureKey, {}, string, Context>[];

  const errorTable: OperationTable<Fixture, FixtureKey, {}, string, Context> = {
    defaultFixture: async () => ({
      fixture: {
        label: "error",
        value: "unused",
        error: { code: "domain_error" },
      },
    }),
    cases: errorCases,
    execute: (fixture) => {
      throw fixture.error;
    },
    observe: (fixture, outcome) => ({
      label: fixture.label,
      outcome,
    }),
  };

  runOperationTable(register, errorTable);

  const aggregateCases = [
    {
      name: "retains every independent assertion failure",
      input: {},
      assert: [
        hasObserved<AggregateContext, TableAssertionError>("assertionFailureNames", ["first", "second"]),
        hasObserved<AggregateContext, TableAssertionError>("assertionMessage", "aggregate: 2 assertion(s) failed"),
      ],
    },
  ] satisfies readonly OperationCase<FixtureKey, {}, TableAssertionError, AggregateContext>[];

  const aggregateTable: OperationTable<Fixture, FixtureKey, {}, TableAssertionError, AggregateContext> = {
    defaultFixture: async () => ({
      fixture: { label: "aggregate", value: "unused" },
    }),
    cases: aggregateCases,
    execute: async () => {
      const failingAssertions: Assertion<{}, string>[] = [
        {
          name: "first",
          check: () => {
            throw new Error("first failure");
          },
        },
        {
          name: "second",
          check: () => {
            throw new Error("second failure");
          },
        },
      ];

      try {
        await assertAll("aggregate", failingAssertions, {}, { ok: true, value: "unused" });
      } catch (error) {
        if (error instanceof TableAssertionError) {
          return error;
        }
        throw error;
      }

      throw new Error("assertAll should have failed");
    },
    observe: (_fixture, outcome) => {
      if (!outcome.ok) {
        throw outcome.error;
      }

      return {
        label: "aggregate",
        outcome,
        assertionFailureNames: outcome.value.failures.map(({ name }) => name),
        assertionMessage: outcome.value.message.split("\n", 1)[0],
      };
    },
  };

  runOperationTable(register, aggregateTable);

  type RunnerProbeInput = "unexpected-outcome" | "setup-failure" | "cleanup-order";
  type RunnerProbeFixture = { events: string[]; error: unknown };
  type RunnerProbeContext = { events: readonly string[]; errorName: string; cleanupErrorCount: number };
  type RunnerProbeResult = undefined;

  const runnerProbeCases = [
    {
      name: "fails when execute throws without an error assertion",
      input: "unexpected-outcome" as const,
      assert: [hasObserved<RunnerProbeContext, RunnerProbeResult>("errorName", "TableAssertionError")],
    },
    {
      name: "runs registered cleanup after fixture setup fails",
      input: "setup-failure" as const,
      assert: [
        hasObserved<RunnerProbeContext, RunnerProbeResult>("events", ["second", "first"]),
        hasObserved<RunnerProbeContext, RunnerProbeResult>("errorName", "TableCleanupError"),
        hasObserved<RunnerProbeContext, RunnerProbeResult>("cleanupErrorCount", 1),
      ],
    },
    {
      name: "runs returned and registered cleanup in LIFO order",
      input: "cleanup-order" as const,
      assert: [
        hasObserved<RunnerProbeContext, RunnerProbeResult>("events", ["returned", "second", "first"]),
        hasObserved<RunnerProbeContext, RunnerProbeResult>("errorName", "TableCleanupError"),
        hasObserved<RunnerProbeContext, RunnerProbeResult>("cleanupErrorCount", 1),
      ],
    },
  ] satisfies readonly OperationCase<"default", RunnerProbeInput, RunnerProbeResult, RunnerProbeContext>[];

  const runnerProbeTable: OperationTable<
    RunnerProbeFixture,
    "default",
    RunnerProbeInput,
    RunnerProbeResult,
    RunnerProbeContext
  > = {
    defaultFixture: () => ({ fixture: { events: [], error: null } }),
    cases: runnerProbeCases,
    execute: async (fixture, input) => {
      const handlers: Array<() => Promise<void>> = [];
      const capture: TestRegistrar = (_name, handler) => {
        handlers.push(async () => {
          await handler();
        });
      };

      if (input === "unexpected-outcome") {
        runOperationTable(capture, {
          defaultFixture: () => ({ fixture: undefined }),
          cases: [
            { name: "nested unexpected", input: {}, assert: [{ name: "observation only", check: () => undefined }] },
          ],
          execute: () => {
            throw new Error("unexpected execute error");
          },
          observe: () => ({}),
        });
      } else {
        runOperationTable(capture, {
          defaultFixture: (registerCleanup) => {
            registerCleanup?.(() => {
              fixture.events.push("first");
            });
            registerCleanup?.(() => {
              fixture.events.push("second");
              throw new Error("second cleanup");
            });
            if (input === "setup-failure") throw new Error("fixture setup failed");
            return {
              fixture: undefined,
              cleanup: () => {
                fixture.events.push("returned");
              },
            };
          },
          cases: [{ name: "nested cleanup", input: {}, assert: [{ name: "completes", check: () => undefined }] }],
          execute: () => undefined,
          observe: () => ({}),
        });
      }

      try {
        await handlers[0]!();
      } catch (error) {
        fixture.error = error;
        return undefined;
      }
      throw new Error("nested table should have failed");
    },
    observe: (fixture) => ({
      events: [...fixture.events],
      errorName: fixture.error instanceof Error ? fixture.error.name : "",
      cleanupErrorCount: fixture.error instanceof TableCleanupError ? fixture.error.cleanupErrors.length : 0,
    }),
  };

  runOperationTable(register, runnerProbeTable);

  type ScopeInput = "success" | "error";
  type ScopeFixture = { events: string[] };
  type ScopeContext = { events: readonly string[] };
  const scopeEvents: string[] = [];
  const scopeCases = [
    {
      name: "wraps successful fixture, execution, observation, and assertions",
      input: "success" as const,
      assert: [hasObserved<ScopeContext, string>("events", ["scope-start", "fixture", "execute", "observe"])],
    },
    {
      name: "wraps expected execution errors in the same case scope",
      input: "error" as const,
      assert: [hasError<ScopeContext, string>({ message: "expected" })],
    },
  ] satisfies readonly OperationCase<"default", ScopeInput, string, ScopeContext>[];

  const scopeTable: OperationTable<ScopeFixture, "default", ScopeInput, string, ScopeContext> = {
    defaultFixture: (registerCleanup) => {
      scopeEvents.push("fixture");
      registerCleanup?.(() => {
        scopeEvents.push("cleanup");
      });
      return { fixture: { events: scopeEvents } };
    },
    caseScope: async (operation) => {
      scopeEvents.length = 0;
      scopeEvents.push("scope-start");
      try {
        return await operation();
      } finally {
        scopeEvents.push("scope-end");
      }
    },
    cases: scopeCases,
    execute: (fixture, input) => {
      fixture.events.push("execute");
      if (input === "error") throw new Error("expected");
      return "ok";
    },
    observe: (fixture) => {
      fixture.events.push("observe");
      return { events: [...fixture.events] };
    },
  };

  runOperationTable(register, scopeTable);
});
