import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonPidRecord } from "@muximo/application";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { consumeMuximodRestartMarker, readMuximodPidRecord, writeMuximodPidRecord } from "./process-files.js";

type ProcessFileInput = "write-pid" | "preserve-invalid-marker";
type ProcessFileResult = DaemonPidRecord | boolean | undefined;
type ProcessFileFixture = {
  root: string;
  pidFile: string;
  markerFile: string;
  record?: DaemonPidRecord;
};
type ProcessFileContext = {
  record: DaemonPidRecord | undefined;
  mode: number | undefined;
  markerExists: boolean;
};

const record: DaemonPidRecord = {
  pid: 401,
  host: "127.0.0.1",
  port: 4317,
  startedAt: "2026-08-28T00:00:00.000Z",
};

const cases = [
  {
    name: "writes a private daemon pid record atomically",
    input: "write-pid" as const,
    assert: [
      hasObserved<ProcessFileContext, ProcessFileResult>("record", record),
      {
        name: "uses a private file mode",
        check: (context: ProcessFileContext) => assert.equal(context.mode, 0o600),
      },
    ],
  },
  {
    name: "preserves an invalid restart marker for fail-closed diagnosis",
    input: "preserve-invalid-marker" as const,
    assert: [
      hasError<ProcessFileContext, ProcessFileResult>({ message: /restart marker has an invalid format/ }),
      hasObserved<ProcessFileContext, ProcessFileResult>("markerExists", true),
    ],
  },
] satisfies readonly OperationCase<"default", ProcessFileInput, ProcessFileResult, ProcessFileContext>[];

const table: OperationTable<ProcessFileFixture, "default", ProcessFileInput, ProcessFileResult, ProcessFileContext> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximod-process-files-test-"));
    const pidFile = join(root, "muximod.pid");
    return {
      fixture: { root, pidFile, markerFile: `${pidFile}.restart` },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  },
  cases,
  execute: (fixture, input) => {
    if (input === "write-pid") {
      writeMuximodPidRecord(fixture.pidFile, record);
      fixture.record = readMuximodPidRecord(fixture.pidFile);
      return fixture.record;
    }
    writeFileSync(fixture.markerFile, "{invalid", { mode: 0o600 });
    return consumeMuximodRestartMarker(fixture.pidFile);
  },
  observe: (fixture) => ({
    record: fixture.record ?? readMuximodPidRecord(fixture.pidFile),
    mode: readMode(fixture.pidFile),
    markerExists: fileExists(fixture.markerFile),
  }),
};

function readMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

describe("muximod process files", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
