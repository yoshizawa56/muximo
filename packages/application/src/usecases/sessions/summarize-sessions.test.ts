import { Pane, PaneId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { MuximodSessionSummary } from "../../ports/application.js";
import { summarizeSessions } from "./summarize-sessions.js";

type Input = {
  sessionNames: readonly string[];
  managedSessionNames: readonly string[];
};

type SummaryFixture = {
  result: MuximodSessionSummary[];
};

type SummaryContext = {
  managed: readonly string[];
};

const summaryCases = [
  {
    name: "marks managed and ordinary tmux sessions separately",
    input: {
      sessionNames: ["muximod", "desktop"],
      managedSessionNames: ["muximod"],
    },
    assert: [
      returns<SummaryContext, MuximodSessionSummary[]>([
        { name: "desktop", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: false },
        { name: "muximod", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: true },
      ]),
      hasObserved<SummaryContext, MuximodSessionSummary[]>("managed", ["desktop:false", "muximod:true"]),
    ],
  },
  {
    name: "defaults sessions to unmanaged when no live marker is present",
    input: {
      sessionNames: ["desktop"],
      managedSessionNames: [],
    },
    assert: [
      returns<SummaryContext, MuximodSessionSummary[]>([
        { name: "desktop", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: false },
      ]),
      hasObserved<SummaryContext, MuximodSessionSummary[]>("managed", ["desktop:false"]),
    ],
  },
] satisfies readonly OperationCase<"default", Input, MuximodSessionSummary[], SummaryContext>[];

const summaryTable: OperationTable<SummaryFixture, "default", Input, MuximodSessionSummary[], SummaryContext> = {
  defaultFixture: (): FixtureHandle<SummaryFixture> => ({ fixture: { result: [] } }),
  cases: summaryCases,
  execute: (fixture, input) => {
    fixture.result = summarizeSessions(
      input.sessionNames.map((sessionName, index) =>
        Pane.create({
          id: PaneId.create(`pane-${index}`),
          hostPaneId: `%${index}`,
          hostServerId: "host-1",
          sessionName,
          windowId: "@0",
          kind: "shell",
          name: "shell",
          cwd: "/workspace",
          initialState: "running",
          lastSeenAt: "2026-08-24T00:00:00.000Z",
        }),
      ),
      new Set(input.managedSessionNames),
    );
    return fixture.result;
  },
  observe: (fixture) => ({
    managed: fixture.result.map((session) => `${session.name}:${session.managed}`),
  }),
};

describe("session summaries", () => {
  runOperationTable(it as unknown as TestRegistrar, summaryTable);
});
