import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonPidRecord, ProcessLaunchRecord } from "@muximo/application";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  consumeMuximodRestartMarker,
  readMuximodLaunchRecord,
  readMuximodPidRecord,
  removeMuximodLaunchRecord,
  writeMuximodLaunchRecord,
  writeMuximodPidRecord,
} from "./process-files.js";

type ProcessFileInput = "write-pid" | "write-launch" | "remove-launch" | "preserve-launch" | "preserve-invalid-marker";
type ProcessFileResult = DaemonPidRecord | ProcessLaunchRecord | boolean | undefined;
type ProcessFileFixture = {
  root: string;
  pidFile: string;
  markerFile: string;
  record?: DaemonPidRecord;
  launchRecord?: ProcessLaunchRecord;
};
type ProcessFileContext = {
  record: DaemonPidRecord | undefined;
  launch: ProcessLaunchRecord | undefined;
  mode: number | undefined;
  launchMode: number | undefined;
  markerExists: boolean;
  launchPresent: boolean;
};

const record: DaemonPidRecord = {
  pid: 401,
  host: "127.0.0.1",
  port: 4317,
  startedAt: "2026-08-28T00:00:00.000Z",
};

const launchRecord: ProcessLaunchRecord = {
  pid: 401,
  startedAt: "2026-08-28T00:00:00.000Z",
  origin: "source",
  executable: "/opt/bun/bin/bun",
  entrypoint: "/work/muximo/packages/muximod/src/process-entrypoint.ts",
  args: ["/work/muximo/packages/muximod/src/process-entrypoint.ts"],
  cwd: "/work/muximo",
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
    name: "writes and reads launch metadata atomically",
    input: "write-launch" as const,
    assert: [
      hasObserved<ProcessFileContext, ProcessFileResult>("launch", launchRecord),
      {
        name: "uses a private launch file mode",
        check: (context: ProcessFileContext) => assert.equal(context.launchMode, 0o600),
      },
    ],
  },
  {
    name: "removes launch metadata only for the recorded process",
    input: "remove-launch" as const,
    assert: [
      hasObserved<ProcessFileContext, ProcessFileResult>("launch", undefined),
      hasObserved<ProcessFileContext, ProcessFileResult>("launchPresent", false),
    ],
  },
  {
    name: "preserves launch metadata for a different process",
    input: "preserve-launch" as const,
    assert: [
      hasObserved<ProcessFileContext, ProcessFileResult>("launch", launchRecord),
      hasObserved<ProcessFileContext, ProcessFileResult>("launchPresent", true),
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
    if (input === "write-launch") {
      writeMuximodLaunchRecord(fixture.pidFile, launchRecord);
      fixture.launchRecord = readMuximodLaunchRecord(fixture.pidFile);
      return fixture.launchRecord;
    }
    if (input === "remove-launch") {
      writeMuximodLaunchRecord(fixture.pidFile, launchRecord);
      removeMuximodLaunchRecord(fixture.pidFile, launchRecord.pid);
      return readMuximodLaunchRecord(fixture.pidFile);
    }
    if (input === "preserve-launch") {
      writeMuximodLaunchRecord(fixture.pidFile, launchRecord);
      removeMuximodLaunchRecord(fixture.pidFile, launchRecord.pid + 1);
      return readMuximodLaunchRecord(fixture.pidFile);
    }
    writeFileSync(fixture.markerFile, "{invalid", { mode: 0o600 });
    return consumeMuximodRestartMarker(fixture.pidFile);
  },
  observe: (fixture) => ({
    record: fixture.record ?? readMuximodPidRecord(fixture.pidFile),
    launch: fixture.launchRecord ?? readMuximodLaunchRecord(fixture.pidFile),
    mode: readMode(fixture.pidFile),
    launchMode: readMode(`${fixture.pidFile}.launch.json`),
    markerExists: fileExists(fixture.markerFile),
    launchPresent: fileExists(`${fixture.pidFile}.launch.json`),
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
