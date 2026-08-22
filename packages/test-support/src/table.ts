export type MaybePromise<T> = T | PromiseLike<T>;
export type Cleanup = () => MaybePromise<void>;
export type CleanupRegistrar = (cleanup: Cleanup) => void;
export type CaseScope = <Result>(operation: () => MaybePromise<Result>) => MaybePromise<Result>;

export type Outcome<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: unknown };

export type FixtureHandle<Fixture> = {
  fixture: Fixture;
  cleanup?: Cleanup;
};

export type FixtureFactory<Fixture> =
  (registerCleanup?: CleanupRegistrar) => MaybePromise<FixtureHandle<Fixture>>;

export function noFixture(): FixtureFactory<undefined> {
  return () => ({ fixture: undefined });
}

export type Assertion<Context, Result> = {
  name: string;
  /** Set this only when this assertion explicitly handles an execute failure. */
  allowsOutcomeError?: boolean;
  check: (
    ctx: Context,
    result: Outcome<Result>,
  ) => MaybePromise<void>;
};

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type TestRegistrar = (
  name: string,
  handler: () => MaybePromise<void>,
) => unknown;

export type OperationCase<
  FixtureKey extends string,
  Input,
  Result,
  Context,
> = {
  name: string;
  fixture?: FixtureKey;
  input: Input;
  assert: NonEmptyArray<Assertion<Context, Result>>;
};

export type OperationTable<
  Fixture,
  FixtureKey extends string,
  Input,
  Result,
  Context,
> = {
  defaultFixture: FixtureFactory<Fixture>;
  fixtures?: Readonly<Record<FixtureKey, FixtureFactory<Fixture>>>;
  /** Wraps fixture setup, execution, observation, and assertions in one case scope. */
  caseScope?: CaseScope;
  cases: readonly OperationCase<FixtureKey, Input, Result, Context>[];
  execute: (
    fixture: Fixture,
    input: Input,
  ) => MaybePromise<Result>;
  observe: (
    fixture: Fixture,
    result: Outcome<Result>,
  ) => MaybePromise<Context>;
};

export type ScenarioCase<
  FixtureKey extends string,
  Step,
  Result,
  Context,
> = {
  name: string;
  fixture?: FixtureKey;
  steps: readonly Step[];
  assert: NonEmptyArray<Assertion<Context, Result>>;
};

export type ScenarioTable<
  Fixture,
  FixtureKey extends string,
  Step,
  Result,
  Context,
> = {
  defaultFixture: FixtureFactory<Fixture>;
  fixtures?: Readonly<Record<FixtureKey, FixtureFactory<Fixture>>>;
  /** Wraps fixture setup, execution, observation, and assertions in one case scope. */
  caseScope?: CaseScope;
  cases: readonly ScenarioCase<FixtureKey, Step, Result, Context>[];
  execute: (
    fixture: Fixture,
    steps: readonly Step[],
  ) => MaybePromise<Result>;
  observe: (
    fixture: Fixture,
    result: Outcome<Result>,
  ) => MaybePromise<Context>;
};

export class TableAssertionError extends AggregateError {
  public readonly caseName: string;
  public readonly failures: readonly {
    name: string;
    error: unknown;
  }[];

  public constructor(
    caseName: string,
    failures: readonly { name: string; error: unknown }[],
  ) {
    const details = failures
      .map(({ name, error }) => `[${name}]\n${formatError(error)}`)
      .join("\n\n");
    super(
      failures.map(({ error }) => error),
      `${caseName}: ${failures.length} assertion(s) failed\n\n${details}`,
    );
    this.name = "TableAssertionError";
    this.caseName = caseName;
    this.failures = failures;
  }
}

export class TableCleanupError extends AggregateError {
  public readonly primaryError: unknown;
  public readonly cleanupError: unknown;
  public readonly cleanupErrors: readonly unknown[];

  public constructor(primaryError: unknown, cleanupErrors: readonly unknown[]) {
    const errors = [
      ...(primaryError === undefined ? [] : [primaryError]),
      ...cleanupErrors,
    ];
    super(
      errors,
      `${primaryError === undefined ? "cleanup failed" : "test and cleanup both failed"}\n\n${
        primaryError === undefined ? "" : `primary:\n${formatError(primaryError)}\n\n`
      }cleanup:\n${cleanupErrors.map(formatError).join("\n\n")}`,
    );
    this.name = "TableCleanupError";
    this.primaryError = primaryError;
    this.cleanupError = cleanupErrors[0];
    this.cleanupErrors = cleanupErrors;
  }
}

export function runOperationTable<
  Fixture,
  FixtureKey extends string,
  Input,
  Result,
  Context,
>(
  register: TestRegistrar,
  table: OperationTable<Fixture, FixtureKey, Input, Result, Context>,
): void {
  validateCases(table.cases);

  for (const testCase of table.cases) {
    register(testCase.name, async () => {
      await runCase({
        caseName: testCase.name,
        fixtureFactory: selectFixtureFactory(table, testCase.fixture),
        caseScope: table.caseScope,
        assert: testCase.assert,
        execute: (fixture) => table.execute(fixture, testCase.input),
        observe: table.observe,
      });
    });
  }
}

export function runScenarioTable<
  Fixture,
  FixtureKey extends string,
  Step,
  Result,
  Context,
>(
  register: TestRegistrar,
  table: ScenarioTable<Fixture, FixtureKey, Step, Result, Context>,
): void {
  validateCases(table.cases);

  for (const testCase of table.cases) {
    register(testCase.name, async () => {
      await runCase({
        caseName: testCase.name,
        fixtureFactory: selectFixtureFactory(table, testCase.fixture),
        caseScope: table.caseScope,
        assert: testCase.assert,
        execute: (fixture) => table.execute(fixture, testCase.steps),
        observe: table.observe,
      });
    });
  }
}

async function runCase<Fixture, Result, Context>({
  caseName,
  fixtureFactory,
  caseScope,
  assert,
  execute,
  observe,
}: {
  caseName: string;
  fixtureFactory: FixtureFactory<Fixture>;
  caseScope?: CaseScope;
  assert: NonEmptyArray<Assertion<Context, Result>>;
  execute: (fixture: Fixture) => MaybePromise<Result>;
  observe: (
    fixture: Fixture,
    result: Outcome<Result>,
  ) => MaybePromise<Context>;
}): Promise<void> {
  let setup: FixtureHandle<Fixture> | undefined;
  const cleanups: Cleanup[] = [];
  let failed = false;
  let failure: unknown;

  const body = async (): Promise<void> => {
    setup = await fixtureFactory((cleanup) => {
      cleanups.push(cleanup);
    });
    if (setup.cleanup) cleanups.push(setup.cleanup);
    const result = await captureOutcome(() => execute(setup!.fixture));
    const ctx = await observe(setup.fixture, result);
    await assertAll(caseName, assert, ctx, result);
  };

  try {
    if (caseScope) {
      await caseScope(body);
    } else {
      await body();
    }
  } catch (error) {
    failed = true;
    failure = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new TableCleanupError(failed ? failure : undefined, cleanupErrors);
  }
  if (failed) {
    throw failure;
  }
}

async function captureOutcome<Result>(
  execute: () => MaybePromise<Result>,
): Promise<Outcome<Result>> {
  try {
    return { ok: true, value: await execute() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function assertAll<Context, Result>(
  caseName: string,
  assertions: readonly Assertion<Context, Result>[],
  ctx: Context,
  result: Outcome<Result>,
): Promise<void> {
  const failures: Array<{ name: string; error: unknown }> = [];

  if (!result.ok && !assertions.some((assertion) => assertion.allowsOutcomeError)) {
    failures.push({
      name: "execute completes without error",
      error: result.error,
    });
  }

  for (const assertion of assertions) {
    try {
      await assertion.check(ctx, result);
    } catch (error) {
      failures.push({ name: assertion.name, error });
    }
  }

  if (failures.length > 0) {
    throw new TableAssertionError(caseName, failures);
  }
}

function selectFixtureFactory<
  Fixture,
  FixtureKey extends string,
  Input,
  Result,
  Context,
>(
  table: OperationTable<Fixture, FixtureKey, Input, Result, Context>,
  key: FixtureKey | undefined,
): FixtureFactory<Fixture>;
function selectFixtureFactory<
  Fixture,
  FixtureKey extends string,
  Step,
  Result,
  Context,
>(
  table: ScenarioTable<Fixture, FixtureKey, Step, Result, Context>,
  key: FixtureKey | undefined,
): FixtureFactory<Fixture>;
function selectFixtureFactory<Fixture, FixtureKey extends string>(
  table: {
    defaultFixture: FixtureFactory<Fixture>;
    fixtures?: Readonly<Record<FixtureKey, FixtureFactory<Fixture>>>;
  },
  key: FixtureKey | undefined,
): FixtureFactory<Fixture> {
  if (key === undefined) {
    return table.defaultFixture;
  }

  const fixtureFactory = table.fixtures?.[key];
  if (!fixtureFactory) {
    throw new Error(`unknown table fixture: ${String(key)}`);
  }
  return fixtureFactory;
}

function validateCases(
  cases: readonly { name: string; assert: readonly unknown[] }[],
): void {
  const names = new Set<string>();

  for (const testCase of cases) {
    if (!testCase.name.trim()) {
      throw new Error("table case names must not be empty");
    }
    if (names.has(testCase.name)) {
      throw new Error(`duplicate table case name: ${testCase.name}`);
    }
    if (testCase.assert.length === 0) {
      throw new Error(`table case has no assertions: ${testCase.name}`);
    }
    const assertionNames = new Set<string>();
    for (const assertion of testCase.assert) {
      const assertionName = (assertion as { name?: unknown }).name;
      if (typeof assertionName !== "string" || !assertionName.trim()) {
        throw new Error(`table assertions must have names: ${testCase.name}`);
      }
      if (assertionNames.has(assertionName)) {
        throw new Error(`duplicate table assertion name: ${testCase.name}: ${assertionName}`);
      }
      assertionNames.add(assertionName);
    }
    names.add(testCase.name);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}
