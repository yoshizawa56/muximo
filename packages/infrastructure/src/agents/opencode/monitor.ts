/**
 * SSE-backed observer for a shared OpenCode server.
 *
 * State mapping follows the OpenCode V1 event bus:
 *   `session.status` busy/retry/idle  -> running / running / waiting_input
 *   `session.idle`                    -> waiting_input
 *   `permission.updated`              -> waiting_approval + action_requested
 *   `permission.replied`              -> running
 *   `session.error` (primary session) -> failed
 * Child sessions, other directories, and sessionless events are ignored.
 */

import type { ActionDescriptor, AgentMonitor, AgentObservation, AgentObservationSink } from "../index.js";
import {
  type OpenCodeClient,
  type OpenCodeEvent,
  type OpenCodeLog,
  type OpenCodePermission,
  type OpenCodeSessionStatus,
  OpenCodeStreamClosedError,
} from "./client.js";

export type OpenCodeMonitorClient = Pick<
  OpenCodeClient,
  "events" | "sessionExists" | "sessionStatus" | "abortSession" | "replyPermission" | "forkSession"
>;

export type OpenCodeMonitorOptions = {
  baseUrl: string;
  sessionId: string;
  /** Project root the server was started in; used to filter global events. */
  workspaceRoot: string;
  client: OpenCodeMonitorClient;
  /** Reconnect delay in ms per attempt; defaults to capped exponential backoff. */
  reconnectDelayMs?: (attempt: number) => number;
  onLog?: OpenCodeLog;
};

export const openCodeMonitorActions = {
  abort: { id: "abort", label: "Abort session" },
  approve: { id: "approve", label: "Approve" },
  reject: { id: "reject", label: "Reject" },
  approveRemember: { id: "approve_remember", label: "Approve and remember" },
  rejectRemember: { id: "reject_remember", label: "Reject and remember" },
  fork: { id: "fork", label: "Fork session" },
} as const;

const terminalStates = new Set<
  AgentObservation & { type: "state_changed" } extends never
    ? never
    : Extract<AgentObservation, { type: "state_changed" }>["state"]
>(["failed", "completed", "stopped"]);

type MonitorState = Extract<AgentObservation, { type: "state_changed" }>["state"];

function defaultReconnectDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

export class OpenCodeMonitor implements AgentMonitor {
  private readonly reconnectDelayMs: (attempt: number) => number;
  private sink: AgentObservationSink | undefined;
  private stopped = true;
  private lastState: MonitorState | undefined;
  private aborted = false;
  private reconnectAttempt = 0;
  private abortController: AbortController | undefined;

  public constructor(private readonly options: OpenCodeMonitorOptions) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? defaultReconnectDelay;
  }

  public actions(): ActionDescriptor[] {
    return Object.values(openCodeMonitorActions);
  }

  public async execute(action: ActionDescriptor, _params?: unknown): Promise<void> {
    const { client, sessionId } = this.options;
    switch (action.id) {
      case openCodeMonitorActions.abort.id: {
        const aborted = await client.abortSession(sessionId);
        if (!aborted) throw new Error(`OpenCode abort was not accepted for session ${sessionId}`);
        this.aborted = true;
        await this.emit("stopped", "session aborted");
        return;
      }
      case openCodeMonitorActions.approve.id:
      case openCodeMonitorActions.approveRemember.id:
      case openCodeMonitorActions.reject.id:
      case openCodeMonitorActions.rejectRemember.id: {
        const permissionId = stringValue(action.metadata?.permissionID);
        if (!permissionId) throw new Error(`permission action ${action.id} requires a permissionID`);
        const response = action.id.startsWith("reject") ? "deny" : "allow";
        const remember = action.id.endsWith("_remember");
        const accepted = await client.replyPermission(sessionId, permissionId, response, remember);
        if (!accepted) throw new Error(`OpenCode permission response was not accepted for ${permissionId}`);
        return;
      }
      case openCodeMonitorActions.fork.id: {
        const forked = await client.forkSession(sessionId);
        if (!forked) throw new Error(`OpenCode fork was not accepted for session ${sessionId}`);
        this.options.onLog?.("info", "opencode.session_forked", { forkedSessionId: forked });
        return;
      }
      default:
        throw new Error(`unknown OpenCode action: ${action.id}`);
    }
  }

  public async start(sink: AgentObservationSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    this.aborted = false;
    this.reconnectAttempt = 0;
    // A stream from a previous start must not outlive a restart. Aborting
    // also releases the HTTP socket so the process can exit when stopped.
    this.abortController?.abort();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    void this.runStream(signal);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    // Abort the in-flight SSE request. Without this the open socket keeps the
    // owning process alive after the primary backend exits, and the process
    // hangs whenever the OpenCode server is intentionally retained (for
    // example when session cleanup is declined).
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async runStream(signal: AbortSignal | undefined): Promise<void> {
    while (!this.stopped) {
      let stream: AsyncGenerator<OpenCodeEvent>;
      try {
        stream = this.options.client.events(signal);
      } catch (error) {
        this.options.onLog?.("warn", "opencode.stream_open_failed", { error: messageOf(error) });
        await this.backoffAndReconcile();
        continue;
      }
      try {
        for await (const event of stream) {
          if (this.stopped) return;
          this.reconnectAttempt = 0;
          await this.handleEvent(event);
        }
      } catch (error) {
        if (this.stopped) return;
        this.options.onLog?.("warn", "opencode.stream_closed", {
          retryable: error instanceof OpenCodeStreamClosedError,
          error: messageOf(error),
        });
      }
      if (this.stopped) return;
      await this.backoffAndReconcile();
    }
  }

  private async backoffAndReconcile(): Promise<void> {
    await sleep(this.reconnectDelayMs(this.reconnectAttempt));
    this.reconnectAttempt += 1;
    if (this.stopped) return;
    await this.reconcile();
  }

  /**
   * After a disconnect, reconcile against the server before changing state.
   * A missing primary session is terminal; everything else re-establishes
   * the last known state instead of inventing a terminal one.
   */
  private async reconcile(): Promise<void> {
    let status: OpenCodeSessionStatus | undefined;
    let exists: boolean | undefined;
    try {
      exists = await this.options.client.sessionExists(this.options.sessionId);
      if (exists) status = await this.options.client.sessionStatus(this.options.sessionId);
    } catch (error) {
      this.options.onLog?.("debug", "opencode.reconcile_failed", { error: messageOf(error) });
      return;
    }
    if (exists === false) {
      await this.emit("failed", "OpenCode session no longer exists");
      return;
    }
    switch (status) {
      case "busy":
        await this.emit("running", "reconnected while busy");
        return;
      case "retry":
        await this.emit("running", "reconnected while retrying");
        return;
      case "idle":
        await this.maybeWaitingInput("reconnected while idle");
        return;
      default:
        // The server is reachable but the session status is unknown; keep
        // the previous state rather than marking the run terminal.
        return;
    }
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    if (event.directory && event.directory !== this.options.workspaceRoot) return;
    const properties = event.properties;
    switch (event.type) {
      case "session.status": {
        if (!this.isPrimarySession(properties.sessionID)) return;
        const status = sessionStatusValue(properties.status);
        if (status === "busy") await this.emit("running", "session busy");
        else if (status === "retry") {
          await this.emit("running", "session retry");
          this.options.onLog?.("warn", "opencode.session_retry", {
            sessionID: properties.sessionID,
            message: stringValue(properties.message),
          });
        } else if (status === "idle") await this.maybeWaitingInput("session idle");
        return;
      }
      case "session.idle": {
        if (!this.isPrimarySession(properties.sessionID)) return;
        await this.maybeWaitingInput("session idle");
        return;
      }
      case "permission.updated": {
        await this.handlePermission(properties as unknown as OpenCodePermission);
        return;
      }
      case "permission.replied": {
        if (!this.isPrimarySession(properties.sessionID)) return;
        await this.emit("running", "permission replied");
        return;
      }
      case "session.error": {
        // `session.error` may be global (no sessionID); only fail the primary.
        if (properties.sessionID !== undefined && !this.isPrimarySession(properties.sessionID)) return;
        if (properties.sessionID === undefined) return;
        await this.emit("failed", `session error: ${errorName(properties.error) ?? "unknown"}`);
        return;
      }
      default:
        // Sessionless events (`server.connected`, `file.edited`, ...) and
        // unsupported session events never affect the primary state.
        return;
    }
  }

  private async handlePermission(permission: OpenCodePermission): Promise<void> {
    if (!this.isPrimarySession(permission.sessionID)) return;
    const permissionId = stringValue(permission.id);
    if (!permissionId) return;
    const title = stringValue(permission.title) ?? "Permission request";
    const metadata: Record<string, unknown> = { permissionID: permissionId, title };
    await this.emit("waiting_approval", `permission: ${title}`);
    for (const action of [openCodeMonitorActions.approve, openCodeMonitorActions.reject]) {
      await this.sink?.({ type: "action_requested", action: { ...action, metadata } });
    }
  }

  private async maybeWaitingInput(reason: string): Promise<void> {
    if (this.aborted) return;
    if (this.lastState === undefined) return;
    if (terminalStates.has(this.lastState as MonitorState)) return;
    await this.emit("waiting_input", reason);
  }

  private isPrimarySession(sessionId: unknown): boolean {
    return sessionId === this.options.sessionId;
  }

  private async emit(state: MonitorState, reason: string): Promise<void> {
    if (this.stopped) return;
    // After an explicit abort only the stopped state may be emitted.
    if (this.aborted && state !== "stopped") return;
    if (this.lastState === state) return;
    // A terminal state is final; late events must not resurrect the run.
    if (terminalStates.has(this.lastState as MonitorState)) return;
    this.lastState = state;
    await this.sink?.({ type: "state_changed", state, reason });
  }
}

function sessionStatusValue(value: unknown): OpenCodeSessionStatus | undefined {
  const entry =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  const type = stringValue(entry?.type);
  return type === "idle" || type === "retry" || type === "busy" ? type : undefined;
}

function errorName(value: unknown): string | undefined {
  const entry =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  return stringValue(entry?.name) ?? stringValue(entry?.message);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
