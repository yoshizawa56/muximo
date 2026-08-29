// This class translates the host port into tmux and process operations.
import { randomUUID } from "node:crypto";
import {
  ApplicationError,
  type CreatePaneInput,
  type HostPaneReference,
  type HostPaneSnapshot,
  type MuximodHostPort,
  type MuximodPaneClassification,
  type MuximodPaneObservation,
  type TerminalHostSnapshot,
} from "@muximo/application";
import type { WorkspaceRecord } from "@muximo/domain";
import { isProcessAlive } from "../process/process.js";
import { classifyTerminalCommand, classifyUnmanagedAgentOutput } from "./observation.js";
import {
  buildMuximoCommand,
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  resolveMuximoCommand,
  type TmuxAdapter,
  type TmuxLiveSnapshot,
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

  public async hasSession(target: string): Promise<boolean> {
    return this.adapter.hasSession(target);
  }

  public async findManagedSessionId(target: string): Promise<string | undefined> {
    const snapshot = await this.listPanesSnapshot();
    return snapshot.panes.find((pane) => pane.sessionName === target)?.muximodManagedSessionId;
  }

  public async configureManagedSession(target: string, managedSessionId: string): Promise<void> {
    configureManagedTmuxSession(this.adapter, target, managedSessionId, resolveMuximoCommand(this.environment));
  }

  public async createManagedSession(target: string, cwd: string): Promise<string> {
    const managedSessionId = randomUUID();
    const binary = resolveMuximoCommand(this.environment);
    let created = false;
    try {
      this.adapter.createSession(
        target,
        cwd,
        buildMuximoShellCommand(binary, {
          MUXIMOD_MANAGED_SESSION_ID: managedSessionId,
          MUXIMOD_MANAGED_SESSION_NAME: target,
        }),
      );
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

  public async killSession(target: string): Promise<void> {
    this.adapter.killSession(target);
  }

  public async attachSession(target: string): Promise<number> {
    return this.adapter.attachSession(target);
  }

  public async createManagedPane(
    input: CreatePaneInput,
    workspace: WorkspaceRecord | undefined,
    cwd: string | undefined,
  ): Promise<string> {
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
    if (!input.targetPaneId)
      throw new ApplicationError("target_pane_required", "targetPaneId is required for a split pane");

    const target = this.adapter.resolvePane(input.targetPaneId);
    if (target.sessionName !== input.sessionName) {
      throw new ApplicationError("target_pane_session_mismatch", "targetPaneId belongs to a different tmux session");
    }
    const snapshot = this.adapter.snapshotWindow(target);
    return this.adapter.splitWindow(command, input.placement, input.targetPaneId, snapshot.zoomed);
  }

  public async resolvePane(target: string): Promise<HostPaneReference> {
    return toHostPaneReference(this.adapter.resolvePane(target));
  }

  public async isWindowZoomed(pane: HostPaneReference): Promise<boolean> {
    return this.adapter.snapshotWindow(toTmuxPaneRef(pane)).zoomed;
  }

  public async splitPane(
    command: string | undefined,
    placement: "right" | "bottom",
    targetPaneId: string,
    zoomed: boolean,
  ): Promise<string> {
    return this.adapter.splitWindow(command, placement, targetPaneId, zoomed);
  }

  public async listPanesSnapshot(): Promise<TerminalHostSnapshot> {
    return mapTmuxSnapshotToTerminalHostSnapshot(this.adapter.listPanesSnapshot());
  }

  public async classifyCommand(command: string): Promise<MuximodPaneClassification> {
    return classifyTerminalCommand(command);
  }

  public async observeUnmanagedAgent(
    paneId: string,
    fallbackState: Parameters<typeof classifyUnmanagedAgentOutput>[1],
  ): Promise<MuximodPaneObservation> {
    try {
      return classifyUnmanagedAgentOutput(this.adapter.capturePane(paneId), fallbackState);
    } catch {
      return { state: fallbackState };
    }
  }

  public async setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): Promise<void> {
    this.adapter.setAgentPaneMetadata(paneId, field, value);
  }

  public async setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): Promise<void> {
    this.adapter.setAgentExecutionMetadata(paneId, agentSessionId, executionId);
  }

  public async clearAgentExecutionMetadata(paneId: string, expectedExecutionId = ""): Promise<boolean> {
    return this.adapter.clearAgentExecutionMetadata(paneId, expectedExecutionId);
  }

  public async resetAgentPaneMetadata(paneId: string): Promise<void> {
    this.adapter.resetAgentPaneMetadata(paneId);
  }

  public async isProcessAlive(pid: number, expectedStartedAt?: string): Promise<boolean> {
    return isProcessAlive(pid, expectedStartedAt);
  }

  private buildAgentCommand(input: CreatePaneInput, workspace: WorkspaceRecord | undefined): string {
    const binary = resolveMuximoCommand(this.environment);
    if (!input.agentId) throw new ApplicationError("agent_required", "agentId is required for an agent pane");
    const args = [input.agentId, "--no-worktree", "--name", input.name];
    if (input.useWorktree) {
      args.splice(1, 1, "--worktree");
      if (workspace?.setupScriptPath) args.push("--setup-hook", workspace.setupScriptPath);
      if (workspace?.cleanupScriptPath) args.push("--cleanup-hook", workspace.cleanupScriptPath);
    }
    return buildMuximoCommand(binary, "run", args);
  }
}

function toHostPaneReference(pane: TmuxPaneRef): HostPaneReference {
  return {
    hostPaneId: pane.paneId,
    windowId: pane.windowId,
    sessionName: pane.sessionName,
  };
}

function toTmuxPaneRef(pane: HostPaneReference): TmuxPaneRef {
  return {
    paneId: pane.hostPaneId,
    windowId: pane.windowId,
    sessionName: pane.sessionName,
  };
}

export function mapTmuxSnapshotToTerminalHostSnapshot(snapshot: TmuxLiveSnapshot): TerminalHostSnapshot {
  return {
    panes: snapshot.panes.map(toHostPaneSnapshot),
    available: snapshot.available,
    hostServerId: snapshot.tmuxServerId,
    hostServerScope: snapshot.tmuxServerScope,
  };
}

function toHostPaneSnapshot(pane: TmuxLiveSnapshot["panes"][number]): HostPaneSnapshot {
  return {
    hostPaneId: pane.paneId,
    windowId: pane.windowId,
    sessionName: pane.sessionName,
    hostServerId: pane.tmuxServerId,
    muximodSessionId: pane.muximodSessionId,
    muximodExecutionId: pane.muximodExecutionId,
    windowName: pane.windowName,
    windowIndex: pane.windowIndex,
    paneIndex: pane.paneIndex,
    cwd: pane.cwd,
    command: pane.command,
    title: pane.title,
    active: pane.active,
    left: pane.left,
    top: pane.top,
    width: pane.width,
    height: pane.height,
    windowWidth: pane.windowWidth,
    windowHeight: pane.windowHeight,
    muximodPaneId: pane.muximodPaneId,
    muximodName: pane.muximodName,
    muximodKind: pane.muximodKind,
    muximodAgentId: pane.muximodAgentId,
    muximodWorkspaceId: pane.muximodWorkspaceId,
    muximodManagedSessionId: pane.muximodManagedSessionId,
  };
}
