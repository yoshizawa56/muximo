import type { PanePublicationPort, ShellPanePort } from "@muximo/application";
import type { AgentSessionRecord } from "@muximo/domain";
import { errorFields, type Logger } from "../logging/index.js";
import { resolveMuximodPaths } from "../persistence/index.js";
import type { TmuxAdapter } from "../terminal/tmux.js";

export type PaneControlClient = {
  adoptAgentSession(input: { agentSessionId: string; tmuxPaneId: string; executionId: string }): Promise<void>;
  releaseAgentSession(input: { agentSessionId: string; tmuxPaneId: string; executionId: string }): Promise<void>;
  observeAgentSession(input: {
    agentSessionId: string;
    tmuxPaneId: string;
    executionId: string;
    state: "running" | "completed" | "failed" | "stopped";
  }): Promise<void>;
  close(): void;
};

export type PaneControlFactory = (socketPath: string) => Promise<PaneControlClient>;

export type PaneAdapterOptions = {
  environment: NodeJS.ProcessEnv;
  databaseFile: string;
  tmux: TmuxAdapter;
  connect: PaneControlFactory;
  logger: Logger;
};

/** Tmux/control-socket adapter for pane identity and agent observation. */
export class TmuxPanePublicationAdapter implements PanePublicationPort, ShellPanePort {
  public constructor(private readonly options: PaneAdapterOptions) {}

  public async adopt(session: AgentSessionRecord): Promise<void> {
    const pane = currentTmuxPane(this.options.environment);
    if (!pane || !session.executionId) return;
    const input = { agentSessionId: session.id, tmuxPaneId: pane, executionId: session.executionId };
    try {
      const control = await this.options.connect(
        defaultControlSocket(this.options.environment, this.options.databaseFile),
      );
      try {
        await control.adoptAgentSession(input);
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) {
        setFallbackMetadata(this.options.tmux, pane, input);
        return;
      }
      this.options.logger.warn("pane.adopt_failed", { pane, ...errorFields(error) });
    }
  }

  public async release(session: AgentSessionRecord): Promise<void> {
    const pane = currentTmuxPane(this.options.environment);
    if (!pane || !session.executionId) return;
    const input = { agentSessionId: session.id, tmuxPaneId: pane, executionId: session.executionId };
    try {
      const control = await this.options.connect(
        defaultControlSocket(this.options.environment, this.options.databaseFile),
      );
      try {
        await control.releaseAgentSession(input);
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) {
        if (clearFallbackMetadata(this.options.tmux, pane, input)) this.options.tmux.resetAgentPaneMetadata(pane);
        return;
      }
      this.options.logger.warn("pane.release_failed", { pane, ...errorFields(error) });
    }
  }

  public async publish(
    session: AgentSessionRecord,
    state: "running" | "completed" | "failed" | "stopped",
  ): Promise<void> {
    const pane = currentTmuxPane(this.options.environment);
    if (!pane || !session.executionId) return;
    try {
      const control = await this.options.connect(
        defaultControlSocket(this.options.environment, this.options.databaseFile),
      );
      try {
        await control.observeAgentSession({
          agentSessionId: session.id,
          tmuxPaneId: pane,
          executionId: session.executionId,
          state,
        });
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) return;
      this.options.logger.debug("agent.observation_publish_failed", { state, pane, ...errorFields(error) });
    }
  }

  public markShell(name: string): void {
    const pane = currentTmuxPane(this.options.environment);
    if (!pane) return;
    try {
      this.options.tmux.setAgentPaneMetadata(pane, "kind", "shell");
      this.options.tmux.setAgentPaneMetadata(pane, "agent_id", "");
      this.options.tmux.setAgentPaneMetadata(pane, "pane_name", name);
      this.options.tmux.setAgentPaneMetadata(
        pane,
        "managed_session_id",
        this.options.environment.MUXIMOD_MANAGED_SESSION_ID ?? "",
      );
    } catch {
      // A shell outside tmux remains usable.
    }
  }

  public restoreShell(): void {
    const name =
      this.options.environment.MUXIMO_PANE_NAME ?? this.options.environment.MUXIMO_MANAGED_SESSION_NAME ?? "shell";
    this.markShell(name);
  }

  public adoptWorkingDirectory(directory: string): string | undefined {
    if (!this.options.environment.TMUX_PANE) return undefined;
    const previous = process.cwd();
    if (previous !== directory) process.chdir(directory);
    return previous;
  }

  public restoreWorkingDirectory(previous: string | undefined): void {
    if (previous && process.cwd() !== previous) process.chdir(previous);
  }
}

function currentTmuxPane(environment: NodeJS.ProcessEnv): string | undefined {
  const pane = environment.TMUX && environment.TMUX_PANE ? environment.TMUX_PANE.trim() : "";
  return /^%[0-9]+$/.test(pane) ? pane : undefined;
}

function defaultControlSocket(environment: NodeJS.ProcessEnv, databaseFile: string): string {
  return resolveMuximodPaths(environment, { databaseFile }).controlSocket;
}

function setFallbackMetadata(
  tmux: TmuxAdapter,
  pane: string,
  input: { agentSessionId: string; executionId: string },
): void {
  tmux.setPaneOption(pane, "@muximod.agent_session_id", input.agentSessionId);
  tmux.setPaneOption(pane, "@muximod.agent_execution_id", input.executionId);
}

function clearFallbackMetadata(tmux: TmuxAdapter, pane: string, input: { executionId: string }): boolean {
  const current = tmux.command(["show-options", "-q", "-p", "-v", "-t", pane, "@muximod.agent_execution_id"]);
  if (current.status !== 0 || current.stdout.trim() !== input.executionId) return false;
  tmux.command(["set-option", "-p", "-u", "-t", pane, "@muximod.agent_execution_id"]);
  tmux.command(["set-option", "-p", "-u", "-t", pane, "@muximod.agent_session_id"]);
  return true;
}

function isControlSocketUnavailable(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return (
    code === "ENOENT" || code === "ECONNREFUSED" || (typeof code === "string" && code.startsWith("control_socket_"))
  );
}
