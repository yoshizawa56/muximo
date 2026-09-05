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

import { attemptSync } from "@muximo/application";
import { Duration, Effect, Schedule, Stream } from "effect";
import { fromPromise, runEffectAsPromise } from "../../effect.js";
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
type OpenCodeMonitorEffect<A> = Effect.Effect<A, Error>;

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

  public execute(action: ActionDescriptor, _params?: unknown): Promise<void> {
    return runEffectAsPromise(this.executeEffect(action));
  }

  private executeEffect(action: ActionDescriptor): OpenCodeMonitorEffect<void> {
    const { client, sessionId } = this.options;
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        switch (action.id) {
          case openCodeMonitorActions.abort.id: {
            const aborted = yield* client.abortSession(sessionId);
            if (!aborted)
              return yield* Effect.fail(new Error(`OpenCode abort was not accepted for session ${sessionId}`));
            this.aborted = true;
            yield* this.emit("stopped", "session aborted");
            return;
          }
          case openCodeMonitorActions.approve.id:
          case openCodeMonitorActions.approveRemember.id:
          case openCodeMonitorActions.reject.id:
          case openCodeMonitorActions.rejectRemember.id: {
            const permissionId = stringValue(action.metadata?.permissionID);
            if (!permissionId)
              return yield* Effect.fail(new Error(`permission action ${action.id} requires a permissionID`));
            const response = action.id.startsWith("reject") ? "deny" : "allow";
            const remember = action.id.endsWith("_remember");
            const accepted = yield* client.replyPermission(sessionId, permissionId, response, remember);
            if (!accepted)
              return yield* Effect.fail(new Error(`OpenCode permission response was not accepted for ${permissionId}`));
            return;
          }
          case openCodeMonitorActions.fork.id: {
            const forked = yield* client.forkSession(sessionId);
            if (!forked)
              return yield* Effect.fail(new Error(`OpenCode fork was not accepted for session ${sessionId}`));
            this.options.onLog?.("info", "opencode.session_forked", { forkedSessionId: forked });
            return;
          }
          default:
            return yield* Effect.fail(new Error(`unknown OpenCode action: ${action.id}`));
        }
      }.bind(this),
    );
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
    void runEffectAsPromise(this.runStream(signal));
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

  private runStream(signal: AbortSignal | undefined): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        while (!this.stopped) {
          const streamResult = yield* Effect.result(attemptSync(() => this.options.client.events(signal)));
          if (streamResult._tag === "Failure") {
            this.options.onLog?.("warn", "opencode.stream_open_failed", { error: messageOf(streamResult.failure) });
            yield* this.backoffAndReconcile();
            continue;
          }
          const eventsResult = yield* Effect.result(
            Stream.runForEach(streamResult.success, (event) => {
              if (this.stopped) return Effect.succeed(undefined);
              this.reconnectAttempt = 0;
              return this.handleEvent(event);
            }),
          );
          if (this.stopped) return;
          if (eventsResult._tag === "Failure") {
            this.options.onLog?.("warn", "opencode.stream_closed", {
              retryable: eventsResult.failure instanceof OpenCodeStreamClosedError,
              error: messageOf(eventsResult.failure),
            });
          }
          yield* this.backoffAndReconcile();
        }
      }.bind(this),
    );
  }

  private backoffAndReconcile(): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        const step = yield* Schedule.toStepWithSleep(
          Schedule.duration(Duration.millis(this.reconnectDelayMs(this.reconnectAttempt))),
        );
        yield* step(undefined).pipe(Effect.catch(() => Effect.succeed(undefined)));
        this.reconnectAttempt += 1;
        if (this.stopped) return;
        yield* this.reconcile();
      }.bind(this),
    );
  }

  /**
   * After a disconnect, reconcile against the server before changing state.
   * A missing primary session is terminal; everything else re-establishes
   * the last known state instead of inventing a terminal one.
   */
  private reconcile(): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        const result = yield* Effect.result(
          Effect.gen(
            function* (this: OpenCodeMonitor) {
              const exists = yield* this.options.client.sessionExists(this.options.sessionId);
              const status = exists ? yield* this.options.client.sessionStatus(this.options.sessionId) : undefined;
              return { exists, status };
            }.bind(this),
          ),
        );
        if (result._tag === "Failure") {
          this.options.onLog?.("debug", "opencode.reconcile_failed", { error: messageOf(result.failure) });
          return;
        }
        const { exists, status } = result.success;
        if (exists === false) {
          yield* this.emit("failed", "OpenCode session no longer exists");
          return;
        }
        switch (status) {
          case "busy":
            yield* this.emit("running", "reconnected while busy");
            return;
          case "retry":
            yield* this.emit("running", "reconnected while retrying");
            return;
          case "idle":
            yield* this.maybeWaitingInput("reconnected while idle");
            return;
          default:
            // The server is reachable but the session status is unknown; keep
            // the previous state rather than marking the run terminal.
            return;
        }
      }.bind(this),
    );
  }

  private handleEvent(event: OpenCodeEvent): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        if (event.directory && event.directory !== this.options.workspaceRoot) return;
        const properties = event.properties;
        switch (event.type) {
          case "session.status": {
            if (!this.isPrimarySession(properties.sessionID)) return;
            const status = sessionStatusValue(properties.status);
            if (status === "busy") yield* this.emit("running", "session busy");
            else if (status === "retry") {
              yield* this.emit("running", "session retry");
              this.options.onLog?.("warn", "opencode.session_retry", {
                sessionID: properties.sessionID,
                message: stringValue(properties.message),
              });
            } else if (status === "idle") yield* this.maybeWaitingInput("session idle");
            return;
          }
          case "session.idle": {
            if (!this.isPrimarySession(properties.sessionID)) return;
            yield* this.maybeWaitingInput("session idle");
            return;
          }
          case "permission.updated": {
            yield* this.handlePermission(properties as unknown as OpenCodePermission);
            return;
          }
          case "permission.replied": {
            if (!this.isPrimarySession(properties.sessionID)) return;
            yield* this.emit("running", "permission replied");
            return;
          }
          case "session.error": {
            // `session.error` may be global (no sessionID); only fail the primary.
            if (properties.sessionID !== undefined && !this.isPrimarySession(properties.sessionID)) return;
            if (properties.sessionID === undefined) return;
            yield* this.emit("failed", `session error: ${errorName(properties.error) ?? "unknown"}`);
            return;
          }
          default:
            // Sessionless events (`server.connected`, `file.edited`, ...) and
            // unsupported session events never affect the primary state.
            return;
        }
      }.bind(this),
    );
  }

  private handlePermission(permission: OpenCodePermission): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        if (!this.isPrimarySession(permission.sessionID)) return;
        const permissionId = stringValue(permission.id);
        if (!permissionId) return;
        const title = stringValue(permission.title) ?? "Permission request";
        const metadata: Record<string, unknown> = { permissionID: permissionId, title };
        yield* this.emit("waiting_approval", `permission: ${title}`);
        const sink = this.sink;
        if (!sink) return;
        for (const action of [openCodeMonitorActions.approve, openCodeMonitorActions.reject]) {
          yield* fromPromise(() => sink({ type: "action_requested", action: { ...action, metadata } }));
        }
      }.bind(this),
    );
  }

  private maybeWaitingInput(reason: string): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        if (this.aborted) return;
        if (this.lastState === undefined) return;
        if (terminalStates.has(this.lastState as MonitorState)) return;
        yield* this.emit("waiting_input", reason);
      }.bind(this),
    );
  }

  private isPrimarySession(sessionId: unknown): boolean {
    return sessionId === this.options.sessionId;
  }

  private emit(state: MonitorState, reason: string): OpenCodeMonitorEffect<void> {
    return Effect.gen(
      function* (this: OpenCodeMonitor) {
        if (this.stopped) return;
        // After an explicit abort only the stopped state may be emitted.
        if (this.aborted && state !== "stopped") return;
        if (this.lastState === state) return;
        // A terminal state is final; late events must not resurrect the run.
        if (terminalStates.has(this.lastState as MonitorState)) return;
        this.lastState = state;
        const sink = this.sink;
        if (sink) yield* fromPromise(() => sink({ type: "state_changed", state, reason }));
      }.bind(this),
    );
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
