import type { AgentSessionId, Pane, PaneState } from "@muximo/domain";

export type PaneFilter = {
  state?: PaneState;
  kind?: Pane["kind"];
  sessionName?: string;
};

export type ClaimExecutionInput = {
  id: AgentSessionId;
  expectedExecutionPid: number | null;
  executionId: string;
  executionPid: number | null;
  executionStartedAt: string;
  executionOwnerPid: number | null;
  executionOwnerStartedAt: string | null;
  lastActivityAt: string;
};

export type AttachExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  executionPid: number;
  executionStartedAt: string;
  lastActivityAt: string;
};

export type ClaimAbandonedExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionPid: number | null;
  expectedExecutionStartedAt: string | null;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  lastActivityAt: string;
};
