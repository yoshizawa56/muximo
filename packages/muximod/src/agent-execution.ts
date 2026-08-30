import { randomBytes, randomUUID } from "node:crypto";
import type { AgentExecutionPort, AgentExecutionRequest, AgentExecutionResult } from "@muximo/application";
import type { MuximodControlRequest, MuximodControlResponse } from "@muximo/contract/control";

export type AgentExecutionOperation = "run" | "resume";

export type AgentExecutionControlPeer = {
  send(response: MuximodControlResponse): void;
  isOpen(): boolean;
};

export type AgentExecutionScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type AgentExecutionBrokerOptions = {
  reservationTtlMs?: number;
  scheduler?: AgentExecutionScheduler;
};

export type AgentExecutionReservationInput = {
  operation: AgentExecutionOperation;
  hostPaneId?: string;
  ownerPid: number;
};

export type AgentExecutionReservation = {
  token: string;
  ownerPid: number;
};

export type AgentExecutionConsumeInput = {
  token: string;
  operation: AgentExecutionOperation;
  hostPaneId?: string;
};

type CompletionRequest = Extract<MuximodControlRequest, { type: "complete_agent_execution" }>;
type Reservation = AgentExecutionReservationInput & {
  peer: AgentExecutionControlPeer;
  token: string;
  state: "reserved" | "consumed";
  used: boolean;
  timer: unknown;
  pending?: PendingExecution;
};
type PendingExecution = {
  requestId: string;
  executionId: string;
  resolve(result: AgentExecutionResult): void;
  reject(error: Error): void;
};

const defaultReservationTtlMs = 30_000;
const defaultScheduler: AgentExecutionScheduler = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/**
 * Bridges one interactive execution from the daemon to the CLI that owns the
 * terminal. The command payload crosses the private socket, but its stdio
 * remains attached to the CLI process and never crosses this bridge.
 */
export class AgentExecutionBroker {
  private readonly reservations = new Map<string, Reservation>();
  private readonly reservationByPeer = new Map<AgentExecutionControlPeer, string>();

  private readonly reservationTtlMs: number;
  private readonly scheduler: AgentExecutionScheduler;

  public constructor(options: AgentExecutionBrokerOptions = {}) {
    this.reservationTtlMs = options.reservationTtlMs ?? defaultReservationTtlMs;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  public reserve(peer: AgentExecutionControlPeer, input: AgentExecutionReservationInput): AgentExecutionReservation {
    if (!peer.isOpen()) throw new Error("agent execution control connection is closed");
    if (this.reservationByPeer.has(peer)) {
      throw new Error("agent execution is already reserved on this control connection");
    }
    const token = randomBytes(32).toString("base64url");
    const timer = this.scheduler.setTimeout(() => this.expire(token), this.reservationTtlMs);
    const reservation: Reservation = { ...input, peer, token, state: "reserved", used: false, timer };
    this.reservations.set(token, reservation);
    this.reservationByPeer.set(peer, token);
    return { token, ownerPid: input.ownerPid };
  }

  public async consume(input: AgentExecutionConsumeInput): Promise<AgentExecutionPort> {
    const reservation = this.reservations.get(input.token);
    if (reservation?.state !== "reserved") {
      throw new Error("agent execution token is invalid, expired, or already used");
    }
    if (reservation.operation !== input.operation) {
      throw new Error("agent execution token does not match the requested operation");
    }
    if (reservation.hostPaneId !== input.hostPaneId) {
      throw new Error("agent execution token does not match the requested pane");
    }
    if (!reservation.peer.isOpen()) {
      this.deleteReservation(reservation);
      throw new Error("agent execution control connection is closed");
    }
    this.scheduler.clearTimeout(reservation.timer);
    reservation.state = "consumed";
    return {
      ownerPid: reservation.ownerPid,
      execute: (request) => this.execute(reservation, request),
    };
  }

  public complete(peer: AgentExecutionControlPeer, input: CompletionRequest): void {
    const reservation = this.reservations.get(input.token);
    if (!reservation || reservation.peer !== peer) throw new Error("agent execution token is not owned by this client");
    const pending = reservation.pending;
    if (!pending) throw new Error("agent execution has no pending process");
    if (pending.requestId !== input.executionRequestId) {
      throw new Error("agent execution completion does not match the pending request");
    }
    if (pending.executionId !== input.executionId) {
      throw new Error("agent execution completion does not match the pending execution");
    }
    reservation.pending = undefined;
    pending.resolve(input.result);
  }

  public release(peer: AgentExecutionControlPeer, token: string): void {
    const reservation = this.reservations.get(token);
    if (!reservation) return;
    if (reservation.peer !== peer) throw new Error("agent execution token is not owned by this client");
    if (reservation.pending) {
      reservation.pending.reject(new Error("agent execution was released before the process completed"));
    }
    this.deleteReservation(reservation);
  }

  public close(peer: AgentExecutionControlPeer): void {
    for (const reservation of this.reservations.values()) {
      if (reservation.peer !== peer) continue;
      reservation.pending?.reject(new Error("agent execution control connection closed"));
      this.deleteReservation(reservation);
    }
  }

  public closeAll(): void {
    for (const reservation of this.reservations.values()) {
      reservation.pending?.reject(new Error("agent execution broker stopped"));
      this.scheduler.clearTimeout(reservation.timer);
    }
    this.reservations.clear();
    this.reservationByPeer.clear();
  }

  private async execute(reservation: Reservation, request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    if (reservation.state !== "consumed" || reservation.used) {
      throw new Error("agent execution capability has already been used");
    }
    if (!reservation.peer.isOpen()) {
      this.deleteReservation(reservation);
      throw new Error("agent execution control connection is closed");
    }
    reservation.used = true;
    const executionRequestId = randomUUID();
    const result = new Promise<AgentExecutionResult>((resolve, reject) => {
      reservation.pending = {
        requestId: executionRequestId,
        executionId: request.executionId,
        resolve,
        reject,
      };
    });
    try {
      reservation.peer.send({
        type: "execute_agent_process",
        requestId: executionRequestId,
        token: reservation.token,
        executionId: request.executionId,
        sessionId: request.sessionId,
        sessionName: request.sessionName,
        backend: request.backend,
        cwd: request.cwd,
        command: [...request.command],
        environment: { ...request.environment },
      });
      return await result;
    } finally {
      this.deleteReservation(reservation);
    }
  }

  private expire(token: string): void {
    const reservation = this.reservations.get(token);
    if (reservation?.state !== "reserved") return;
    this.deleteReservation(reservation);
  }

  private deleteReservation(reservation: Reservation): void {
    this.scheduler.clearTimeout(reservation.timer);
    this.reservations.delete(reservation.token);
    if (this.reservationByPeer.get(reservation.peer) === reservation.token) {
      this.reservationByPeer.delete(reservation.peer);
    }
  }
}
