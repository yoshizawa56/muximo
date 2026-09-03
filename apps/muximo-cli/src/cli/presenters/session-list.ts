import type { AgentSessionListProjection, AgentSessionListResponse } from "@muximo/contract/api";

export type SessionListPresentationOptions = {
  names: boolean;
  json: boolean;
  showWorkspace: boolean;
};

export type CliSessionListOutput = {
  write(text: string): void;
  info(message: string): void;
};

export function presentCliSessionList(
  input: SessionListPresentationOptions,
  result: AgentSessionListResponse,
  output: CliSessionListOutput,
): number {
  if (input.names) {
    for (const view of result.views) {
      const session = view.session;
      output.write(`${input.showWorkspace ? `${session.workspaceName}/` : ""}${session.name}\n`);
    }
    return 0;
  }
  if (input.json) {
    for (const view of result.views) output.write(`${JSON.stringify(toCliSessionJson(view))}\n`);
    return 0;
  }
  if (input.showWorkspace) {
    output.write(padHeader(["WORKSPACE", "NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
  } else {
    output.write(padHeader(["NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
  }
  if (result.views.length === 0) {
    output.info(
      result.allViews.length === 0
        ? "no managed sessions"
        : "no visible managed sessions; use --all to include unavailable sessions",
    );
    return 0;
  }
  for (const view of result.views) {
    const session = view.session;
    const values = [
      session.name,
      session.backend,
      session.status,
      sessionHealthLabel(view.executionHealth),
      sessionResumeLabel(view.resume),
      session.branch ?? "-",
      session.worktreePath ?? "-",
    ];
    output.write(input.showWorkspace ? padRow([session.workspaceName, ...values]) : padRow(values));
  }
  return 0;
}

export function toCliSessionJson(view: AgentSessionListProjection): Record<string, unknown> {
  const { session } = view;
  return {
    id: session.id,
    name: session.name,
    backend: session.backend,
    status: session.status,
    health: view.executionHealth,
    resume: view.resume,
    resume_reason: view.resumeReason,
    workspace: session.workspaceRoot,
    workspace_id: session.workspaceId,
    workspace_name: session.workspaceName,
    worktree: session.worktreePath,
    worktree_state: view.worktreeState,
    branch: session.branch,
    session_id: session.backendSessionId,
    last_activity_at: session.lastActivityAt,
  };
}

function sessionHealthLabel(health: AgentSessionListProjection["executionHealth"]): string {
  return health === "inactive" ? "-" : health.replaceAll("_", "-");
}

function sessionResumeLabel(resume: AgentSessionListProjection["resume"]): string {
  if (resume === "available") return "yes";
  if (resume === "unavailable") return "no";
  return "?";
}

function padHeader(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}

function padRow(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}
