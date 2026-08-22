// This class translates the host port into tmux and process operations.
import { randomUUID } from "node:crypto";
import { ApplicationError, type CreatePaneInput, type MuximodHostPort } from "@muximo/application";
import type { AgentBackend, WorkspaceRecord } from "@muximo/domain";
import {
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  resolveMuximoCommand,
  TmuxAdapter,
  type TmuxPaneRef,
} from "./tmux.js";

export class TmuxMuximodHostAdapter implements MuximodHostPort {
  public constructor(
    private readonly adapter: TmuxAdapter,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  public newId(): string {
    return randomUUID();
  }

  public hasSession(target: string): boolean {
    return this.adapter.hasSession(target);
  }

  public createManagedSession(target: string, cwd: string): string {
    const managedSessionId = randomUUID();
    const binary = resolveMuximoCommand(this.environment);
    let created = false;
    try {
      this.adapter.createSession(target, cwd, buildMuximoShellCommand(binary, {
        MUXIMOD_MANAGED_SESSION_ID: managedSessionId,
        MUXIMOD_MANAGED_SESSION_NAME: target,
      }));
      created = true;
      configureManagedTmuxSession(this.adapter, target, managedSessionId, binary);
      return managedSessionId;
    } catch (error) {
      if (created) {
        try {
          this.adapter.killSession(target);
        } catch {
          // Preserve the original setup error; cleanup is best effort.
        }
      }
      throw error;
    }
  }

  public killSession(target: string): void {
    this.adapter.killSession(target);
  }

  public attachSession(target: string): number {
    return this.adapter.attachSession(target);
  }

  public createManagedPane(input: CreatePaneInput, workspace: WorkspaceRecord | undefined, cwd: string | undefined): string {
    const paneName = input.name;
    const command = buildMuximoShellCommand(
      resolveMuximoCommand(this.environment),
      {
        MUXIMOD_MANAGED_SESSION_NAME: input.sessionName,
        MUXIMOD_PANE_NAME: paneName,
        ...(input.useWorktree ? { MUXIMOD_WORKTREE_SESSION_NAME: paneName } : {}),
        ...(workspace ? { MUXIMOD_WORKSPACE_ID: workspace.id } : {}),
      },
      input.kind === "agent" ? this.buildAgentCommand(input, workspace) : undefined,
      input.kind === "shell" && input.useWorktree ? ["--worktree", paneName] : [],
    );

    if (input.placement === "window") return this.adapter.newWindow(input.sessionName, cwd, command);
    if (!input.targetPaneId) throw new ApplicationError("target_pane_required", "targetPaneId is required for a split pane");

    const target = this.adapter.resolvePane(input.targetPaneId);
    if (target.sessionName !== input.sessionName) {
      throw new ApplicationError("target_pane_session_mismatch", "targetPaneId belongs to a different tmux session");
    }
    const snapshot = this.adapter.snapshotWindow(target);
    return this.adapter.splitWindow(command, input.placement, input.targetPaneId, snapshot.zoomed);
  }

  public resolvePane(target: string): TmuxPaneRef {
    return this.adapter.resolvePane(target);
  }

  public isWindowZoomed(pane: TmuxPaneRef): boolean {
    return this.adapter.snapshotWindow(pane).zoomed;
  }

  public splitPane(command: string | undefined, placement: "right" | "bottom", targetPaneId: string, zoomed: boolean): string {
    return this.adapter.splitWindow(command, placement, targetPaneId, zoomed);
  }

  public listPanesSnapshot() {
    return this.adapter.listPanesSnapshot();
  }

  public setAgentPaneMetadata(paneId: string, field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id", value: string): void {
    this.adapter.setAgentPaneMetadata(paneId, field, value);
  }

  public setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): void {
    this.adapter.setAgentExecutionMetadata(paneId, agentSessionId, executionId);
  }

  public clearAgentExecutionMetadata(paneId: string, expectedExecutionId = ""): boolean {
    return this.adapter.clearAgentExecutionMetadata(paneId, expectedExecutionId);
  }

  public resetAgentPaneMetadata(paneId: string): void {
    this.adapter.resetAgentPaneMetadata(paneId);
  }

  public capturePane(paneId: string, lines = 48): string {
    return this.adapter.capturePane(paneId, lines);
  }

  public isManagedMuximoCommand(command: string, backend: AgentBackend): boolean {
    const executable = executableName(command);
    const configuredMuximo = executableName(this.environment.MUXIMOD_MUXIMO_COMMAND ?? "muximo");
    const resolvedMuximo = executableName(resolveMuximoCommand(this.environment));
    return executable === "muximo"
      || executable === configuredMuximo
      || executable === resolvedMuximo
      || executable === backend
      || (resolveMuximoCommand(this.environment).endsWith(".ts") && executable === "bun");
  }

  public isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM";
    }
  }

  private buildAgentCommand(input: CreatePaneInput, workspace: WorkspaceRecord | undefined): string {
    const binary = resolveMuximoCommand(this.environment);
    const args = [binary, "run", input.agentId!, "--no-worktree", "--name", input.name];
    if (input.useWorktree) {
      args.splice(3, 1, "--worktree");
      if (workspace?.setupScriptPath) args.push("--setup-hook", workspace.setupScriptPath);
      if (workspace?.cleanupScriptPath) args.push("--cleanup-hook", workspace.cleanupScriptPath);
    }
    return args.map(shellQuote).join(" ");
  }
}

function executableName(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.split("/").at(-1)?.toLowerCase() ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
