import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { appendCameraErrorDetails } from "./-qr-pairing-scanner-error";

type Input = { message: string; cause: unknown };
type Context = {};

const cases = [
  {
    name: "includes the browser error name and message",
    input: {
      message: "Camera access failed.",
      cause: Object.assign(new Error("Failed to load"), { name: "NotReadableError" }),
    },
    assert: [returns<Context, string>("Camera access failed. Details: NotReadableError: Failed to load")],
  },
  {
    name: "includes a string failure",
    input: { message: "Camera access failed.", cause: "camera service unavailable" },
    assert: [returns<Context, string>("Camera access failed. Details: camera service unavailable")],
  },
  {
    name: "serializes a structured failure",
    input: { message: "Camera access failed.", cause: { code: "E_CAMERA_START" } },
    assert: [returns<Context, string>('Camera access failed. Details: {"code":"E_CAMERA_START"}')],
  },
  {
    name: "keeps the friendly message when no details exist",
    input: { message: "Camera access failed.", cause: {} },
    assert: [returns<Context, string>("Camera access failed.")],
  },
] satisfies readonly OperationCase<"default", Input, string, Context>[];

const table: OperationTable<undefined, "default", Input, string, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => appendCameraErrorDetails(input.message, input.cause),
  observe: () => ({}),
};

describe("QR scanner error details", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
