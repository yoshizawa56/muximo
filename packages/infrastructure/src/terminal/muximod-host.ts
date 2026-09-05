// This class translates the host port into tmux and process operations.
import { randomUUID } from "node:crypto";
import {
  type ApplicationEffect,
  ApplicationError,
  type CreatePaneInput,
  type HostPaneReference,
  type HostPaneSnapshot,
  type MuximodHost,
  type MuximodPaneClassification,
  type MuximodPaneObservation,
  type TerminalHostSnapshot,
} from "@muximo/application";
import type { Workspace } from "@muximo/domain";
import { fromPromise } from "../effect.js";
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

export class TmuxMuximodHostAdapter implements MuximodHost {
  public constructor(
    private readonly adapter: TmuxAdapter,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  public newId(): string {
    return randomUUID();
  }

  public hasSession(target: string): ApplicationEffect<boolean> {
    return fromPromise(() => this.adapter.hasSession(target));
  }

  public findManagedSessionId(target: string): ApplicationEffect<string | undefined> {
    return fromPromise(() => {
      const snapshot = this.readSnapshot();
      return snapshot.panes.find((pane) => pane.sessionName === target)?.muximodManagedSessionId;
    });
  }

  public configureManagedSession(target: string, managedSessionId: string): ApplicationEffect<void> {
    return fromPromise(() => {
      configureManagedTmuxSession(this.adapter, target, managedSessionId, resolveMuximoCommand(this.environment));
    });
  }

  public createManagedSession(target: string, cwd: string): ApplicationEffect<string> {
    return fromPromise(() => {
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
    });
  }

  public killSession(target: string): ApplicationEffect<void> {
    return fromPromise(() => {
      this.adapter.killSession(target);
    });
  }

  public attachSession(target: string): ApplicationEffect<number> {
    return fromPromise(() => this.adapter.attachSession(target));
  }

  public createManagedPane(
    input: CreatePaneInput,
    workspace: Workspace | undefined,
    cwd: string | undefined,
  ): ApplicationEffect<string> {
    return fromPromise(() => {
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
    });
  }

  public resolvePane(target: string): ApplicationEffect<HostPaneReference> {
    return fromPromise(() => toHostPaneReference(this.adapter.resolvePane(target)));
  }

  public isWindowZoomed(pane: HostPaneReference): ApplicationEffect<boolean> {
    return fromPromise(() => this.adapter.snapshotWindow(toTmuxPaneRef(pane)).zoomed);
  }

  public splitPane(
    command: string | undefined,
    placement: "right" | "bottom",
    targetPaneId: string,
    zoomed: boolean,
  ): ApplicationEffect<string> {
    return fromPromise(() => this.adapter.splitWindow(command, placement, targetPaneId, zoomed));
  }

  public listPanesSnapshot(): ApplicationEffect<TerminalHostSnapshot> {
    return fromPromise(() => this.readSnapshot());
  }

  public classifyCommand(command: string): ApplicationEffect<MuximodPaneClassification> {
    return fromPromise(() => classifyTerminalCommand(command));
  }

  public observeUnmanagedAgent(
    paneId: string,
    fallbackState: Parameters<typeof classifyUnmanagedAgentOutput>[1],
  ): ApplicationEffect<MuximodPaneObservation> {
    return fromPromise(() => {
      try {
        return classifyUnmanagedAgentOutput(this.adapter.capturePane(paneId), fallbackState);
      } catch {
        return { state: fallbackState };
      }
    });
  }

  public setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): ApplicationEffect<void> {
    return fromPromise(() => {
      this.adapter.setAgentPaneMetadata(paneId, field, value);
    });
  }

  public setAgentExecutionMetadata(
    paneId: string,
    agentSessionId: string,
    executionId: string,
  ): ApplicationEffect<void> {
    return fromPromise(() => {
      this.adapter.setAgentExecutionMetadata(paneId, agentSessionId, executionId);
    });
  }

  public clearAgentExecutionMetadata(paneId: string, expectedExecutionId = ""): ApplicationEffect<boolean> {
    return fromPromise(() => this.adapter.clearAgentExecutionMetadata(paneId, expectedExecutionId));
  }

  public resetAgentPaneMetadata(paneId: string): ApplicationEffect<void> {
    return fromPromise(() => {
      this.adapter.resetAgentPaneMetadata(paneId);
    });
  }

  public isProcessAlive(pid: number, expectedStartedAt?: string): ApplicationEffect<boolean> {
    return fromPromise(() => isProcessAlive(pid, expectedStartedAt));
  }

  private readSnapshot(): TerminalHostSnapshot {
    return mapTmuxSnapshotToTerminalHostSnapshot(this.adapter.listPanesSnapshot());
  }

  private buildAgentCommand(input: CreatePaneInput, workspace: Workspace | undefined): string {
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
