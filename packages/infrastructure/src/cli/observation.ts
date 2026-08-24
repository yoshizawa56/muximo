import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  AgentSessionListObservation,
  AgentSessionWorktreeState,
  ProcessObservationPort,
  SessionObservationPort,
} from "@muximo/application";
import { shouldCheckAgentSessionWorktree } from "@muximo/application";
import type { AgentSessionRecord } from "@muximo/domain";
import { isProcessAlive } from "../process/process.js";
import { realpathSafe } from "./filesystem.js";

export type SessionObservationOptions = {
  environment: NodeJS.ProcessEnv;
  resolveWorkspace(): Promise<{ id: AgentSessionRecord["workspaceId"] }>;
};

/** Filesystem/process observation adapter for the application list projection. */
export class AgentSessionObservationAdapter implements SessionObservationPort {
  public constructor(private readonly options: SessionObservationOptions) {}

  public resolveWorkspace(): Promise<{ id: AgentSessionRecord["workspaceId"] }> {
    return this.options.resolveWorkspace();
  }

  public async observeSession(session: AgentSessionRecord, now: number): Promise<AgentSessionListObservation> {
    const processAlive =
      (session.status === "running" || session.status === "resuming") && session.executionPid !== undefined
        ? isProcessAlive(session.executionPid)
        : undefined;
    return {
      now,
      processAlive,
      worktreeState: this.inspectWorktree(session, now),
      backendResumeState: session.backendSessionId
        ? "available"
        : session.backend === "codex"
          ? "discovery_required"
          : "missing",
    };
  }

  private inspectWorktree(session: AgentSessionRecord, now: number): AgentSessionWorktreeState {
    if (!session.useWorktree) return "not_applicable";
    if (!shouldCheckAgentSessionWorktree(session, now)) return "unknown";
    if (!session.worktreePath || !existsSync(session.worktreePath)) return "missing";
    const workspaceRoot = realpathSafe(session.workspaceRoot);
    try {
      const output = execFileSync("git", ["-C", workspaceRoot, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
        env: this.options.environment,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const paths = new Set(
        output
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("worktree "))
          .map((line) => realpathSafe(line.slice("worktree ".length).trim())),
      );
      return paths.has(realpathSafe(session.worktreePath)) ? "available" : "unregistered";
    } catch {
      return "unknown";
    }
  }
}

export class ProcessObservationAdapter implements ProcessObservationPort {
  public isAlive(pid: number): Promise<boolean> {
    return Promise.resolve(isProcessAlive(pid));
  }
}
