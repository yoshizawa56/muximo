import type { PaneSummary } from "@muximo/contract/api";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { storyPanes } from "../../../../../../-story-fixtures";
import { reconcileWaitingNotices, type WaitingNotice, waitingNoticeTimerKey } from "./controller";

type ReconcileInput = {
  current: readonly WaitingNotice[];
  panes: readonly PaneSummary[];
  previousWaitingIds: readonly string[];
};

type ReconcileResult = {
  noticeIds: string[];
  waitingIds: string[];
  previousTimerKey: string;
  nextTimerKey: string;
};

type Context = {};

const reviewPane = storyPanes[0];
const approvalPane = storyPanes[3];
if (!reviewPane || !approvalPane) throw new Error("Missing waiting pane story fixtures");

const reviewNotice: WaitingNotice = {
  id: reviewPane.id,
  target: reviewPane.hostPaneId,
  name: reviewPane.name,
  kind: "agent",
  agentId: reviewPane.agentId,
  state: "waiting_input",
  cwd: reviewPane.cwd,
  recentOutput: reviewPane.recentOutput ?? "",
};

const approvalNotice: WaitingNotice = {
  id: approvalPane.id,
  target: approvalPane.hostPaneId,
  name: approvalPane.name,
  kind: "agent",
  agentId: approvalPane.agentId,
  state: "waiting_approval",
  cwd: approvalPane.cwd,
  recentOutput: approvalPane.recentOutput ?? "",
};

const cases = [
  {
    name: "replaces a resolved notice with a newly waiting notice at the same count",
    input: {
      current: [reviewNotice],
      panes: [approvalPane],
      previousWaitingIds: [reviewPane.id],
    },
    assert: [
      returns<Context, ReconcileResult>({
        noticeIds: [approvalPane.id],
        waitingIds: [approvalPane.id],
        previousTimerKey: waitingNoticeTimerKey([reviewNotice]),
        nextTimerKey: waitingNoticeTimerKey([approvalNotice]),
      }),
    ],
  },
  {
    name: "removes a resolved notice when no new notice is added",
    input: {
      current: [reviewNotice],
      panes: [{ ...reviewPane, state: "running" as const }],
      previousWaitingIds: [reviewPane.id],
    },
    assert: [
      returns<Context, ReconcileResult>({
        noticeIds: [],
        waitingIds: [],
        previousTimerKey: waitingNoticeTimerKey([reviewNotice]),
        nextTimerKey: waitingNoticeTimerKey([]),
      }),
    ],
  },
  {
    name: "keeps an unresolved notice when the pane projection has no additions",
    input: {
      current: [reviewNotice],
      panes: [reviewPane],
      previousWaitingIds: [reviewPane.id],
    },
    assert: [
      returns<Context, ReconcileResult>({
        noticeIds: [reviewPane.id],
        waitingIds: [reviewPane.id],
        previousTimerKey: waitingNoticeTimerKey([reviewNotice]),
        nextTimerKey: waitingNoticeTimerKey([reviewNotice]),
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ReconcileInput, ReconcileResult, Context>[];

const table: OperationTable<undefined, "default", ReconcileInput, ReconcileResult, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => {
    const result = reconcileWaitingNotices(input.current, input.panes, new Set(input.previousWaitingIds));
    return {
      noticeIds: result.notices.map((notice) => notice.id),
      waitingIds: [...result.waitingIds],
      previousTimerKey: waitingNoticeTimerKey(input.current),
      nextTimerKey: waitingNoticeTimerKey(result.notices),
    };
  },
  observe: () => ({}),
};

describe("waiting notification controller", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
