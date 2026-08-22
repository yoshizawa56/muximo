import { expect } from "vitest";
import type { Assertion } from "./table.js";

export type DomainErrorExpectation = {
  code?: string;
  message?: string | RegExp;
  details?: unknown;
  name?: string;
  reason?: string;
  status?: number;
  [key: string]: unknown;
};

export function hasNoError<Context, Result>(): Assertion<Context, Result> {
  return {
    name: "has no error",
    check: (_ctx, result) => {
      expect(result.ok).toBe(true);
    },
  };
}

export function returns<Context, Result>(expected: Result): Assertion<Context, Result> {
  return {
    name: "returns the expected value",
    check: (_ctx, result) => {
      expect(result).toEqual({ ok: true, value: expected });
    },
  };
}

export function hasError<Context, Result>(expected: DomainErrorExpectation): Assertion<Context, Result> {
  return {
    name: `has error${expected.code ? `: ${expected.code}` : ""}`,
    allowsOutcomeError: true,
    check: (_ctx, result) => {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const comparableError =
          result.error instanceof Error
            ? Object.assign({}, result.error, { name: result.error.name, message: result.error.message })
            : result.error;
        const { message, ...otherFields } = expected;
        expect(comparableError).toMatchObject(otherFields);
        if (message !== undefined) {
          const actualMessage =
            result.error instanceof Error
              ? result.error.message
              : (comparableError as { message?: unknown } | null | undefined)?.message;
          if (message instanceof RegExp) expect(actualMessage).toMatch(message);
          else expect(actualMessage).toBe(message);
        }
      }
    },
  };
}

export function hasObserved<Context, Result>(key: string, expected: unknown): Assertion<Context, Result> {
  return {
    name: `observes ${key}`,
    check: (ctx) => {
      expect((ctx as Record<string, unknown>)[key]).toEqual(expected);
    },
  };
}

export function hasCalls<Context, Result>(key: string, expected: unknown): Assertion<Context, Result> {
  return {
    name: `has calls ${key}`,
    check: (ctx) => {
      expect((ctx as Record<string, unknown>)[key]).toEqual(expected);
    },
  };
}

export function hasEvents<Context, Result>(key: string, expected: unknown): Assertion<Context, Result> {
  return {
    name: `has events ${key}`,
    check: (ctx) => {
      expect((ctx as Record<string, unknown>)[key]).toEqual(expected);
    },
  };
}
