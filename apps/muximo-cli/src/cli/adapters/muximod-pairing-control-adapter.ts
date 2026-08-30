import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type {
  ApprovedDevice,
  PairDeviceInput,
  PairingClaim,
  PairingControlPort,
  PairingOffer,
} from "@muximo/application";
import type { AuthSessionResponse } from "@muximo/contract/api";
import {
  decodeMuximodControlResponse,
  encodeMuximodControlRequest,
  type MuximodControlLogResult,
  type MuximodControlRequest,
  type MuximodControlResponse,
  muximodControlMaxResponseBytes,
} from "@muximo/contract/control";
import { sanitizeProcessDiagnostic } from "@muximo/infrastructure/cli-client";

type AgentStatus = Extract<MuximodControlRequest, { type: "observe_agent_session" }>["state"];
type AgentExecutionStart = Extract<MuximodControlResponse, { type: "execute_agent_process" }>;
type AgentExecutionResult = Extract<MuximodControlRequest, { type: "complete_agent_execution" }>["result"];
type MuximodControlCommand = MuximodControlRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId">
    : never
  : never;
type ResponseWaiter = {
  resolve(response: MuximodControlResponse): void;
  reject(error: PairingControlError): void;
};

export class PairingControlError extends Error {
  public constructor(
    message: string,
    public readonly code = "pairing_control_error",
  ) {
    super(message);
    this.name = "PairingControlError";
  }
}

export type MuximodPairingControlAdapterOptions = {
  onAgentExecution?: (request: AgentExecutionStart, signal: AbortSignal) => Promise<AgentExecutionResult>;
};

/** Unix-socket adapter for muximod's private pairing and pane control protocol. */
export class MuximodPairingControlAdapter implements PairingControlPort {
  private readonly reader: Interface;
  private readonly responses: AsyncIterableIterator<string>;
  private requestQueue: Promise<void> = Promise.resolve();
  private readonly pendingClaims: Extract<MuximodControlResponse, { type: "pairing_claimed" }>[] = [];
  private readonly activeAgentExecutions = new Map<string, AbortController>();
  private readonly responseQueue: MuximodControlResponse[] = [];
  private readonly responseWaiters: ResponseWaiter[] = [];
  private socketError: PairingControlError | undefined;
  private closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly options: MuximodPairingControlAdapterOptions = {},
  ) {
    socket.on("error", (error) => {
      const failure = new PairingControlError(
        `muximod control socket failed: ${error.message}`,
        "control_socket_error",
      );
      this.failResponses(failure);
    });
    this.reader = createInterface({ input: socket, crlfDelay: Infinity });
    this.responses = this.reader[Symbol.asyncIterator]();
    socket.on("close", () => {
      this.closed = true;
      for (const controller of this.activeAgentExecutions.values()) controller.abort();
      this.activeAgentExecutions.clear();
      this.failResponses(new PairingControlError("muximod control socket closed", "control_socket_closed"));
    });
    void this.readResponses();
  }

  public static async connect(
    socketPath: string,
    options: MuximodPairingControlAdapterOptions = {},
  ): Promise<MuximodPairingControlAdapter> {
    return new MuximodPairingControlAdapter(await connectControlSocket(socketPath), options);
  }

  public async createPairing(input: PairDeviceInput): Promise<PairingOffer> {
    const response = await this.request({ type: "create_pairing", muximodBaseUrl: input.muximodBaseUrl });
    if (response.type !== "pairing_created" || response.pairingId !== response.payload.pairingId) {
      throw unexpectedResponse("pairing_created", response.type);
    }
    return {
      pairingId: response.pairingId,
      pairingCode: response.pairingCode,
      muximodBaseUrl: response.payload.muximodBaseUrl,
      expiresAt: response.payload.expiresAt,
    };
  }

  public async createLocalSession(): Promise<AuthSessionResponse> {
    const response = await this.request({ type: "create_local_session" });
    if (response.type !== "local_session_created") {
      throw unexpectedResponse("local_session_created", response.type);
    }
    return response.session;
  }

  public async readLog(lines: number): Promise<MuximodControlLogResult> {
    const response = await this.request({ type: "read_log", lines });
    if (response.type !== "daemon_log") throw unexpectedResponse("daemon_log", response.type);
    return response;
  }

  public async reserveAgentExecution(input: {
    operation: "run" | "resume";
    hostPaneId?: string;
    ownerPid: number;
  }): Promise<{ token: string; ownerPid: number }> {
    const response = await this.request({ type: "reserve_agent_execution", ...input });
    if (response.type !== "agent_execution_reserved") {
      throw unexpectedResponse("agent_execution_reserved", response.type);
    }
    return { token: response.token, ownerPid: response.ownerPid };
  }

  public async releaseAgentExecution(token: string): Promise<void> {
    const response = await this.request({ type: "release_agent_execution", token });
    if (response.type !== "agent_execution_released" || response.token !== token) {
      throw unexpectedResponse("agent_execution_released", response.type);
    }
  }

  public async waitForClaim(pairingId: string): Promise<PairingClaim> {
    while (true) {
      const pendingIndex = this.pendingClaims.findIndex((claim) => claim.pairingId === pairingId);
      if (pendingIndex >= 0) {
        const [response] = this.pendingClaims.splice(pendingIndex, 1);
        if (response) return toPairingClaim(response);
      }
      const response = await this.nextResponse();
      if (response.type === "pairing_claimed") {
        if (response.pairingId === pairingId) return toPairingClaim(response);
        this.pendingClaims.push(response);
        continue;
      }
      if (response.type === "error") throw controlError(response);
      throw unexpectedResponse("pairing_claimed", response.type);
    }
  }

  public async approvePairing(pairingId: string): Promise<ApprovedDevice> {
    const response = await this.request({ type: "approve_pairing", pairingId });
    if (
      response.type !== "pairing_result" ||
      response.pairingId !== pairingId ||
      response.status !== "approved" ||
      !response.deviceId
    ) {
      throw unexpectedResponse("approved pairing_result", response.type);
    }
    return { deviceId: response.deviceId };
  }

  public async rejectPairing(pairingId: string): Promise<void> {
    const response = await this.request({ type: "reject_pairing", pairingId });
    if (response.type !== "pairing_result" || response.pairingId !== pairingId || response.status !== "rejected") {
      throw unexpectedResponse("rejected pairing_result", response.type);
    }
  }

  public async adoptAgentSession(input: {
    agentSessionId: string;
    hostPaneId: string;
    executionId: string;
  }): Promise<void> {
    const response = await this.request({ type: "adopt_agent_session", ...input });
    if (
      response.type !== "agent_session_adopted" ||
      response.agentSessionId !== input.agentSessionId ||
      response.hostPaneId !== input.hostPaneId ||
      response.executionId !== input.executionId
    ) {
      throw unexpectedResponse("agent_session_adopted", response.type);
    }
  }

  public async observeAgentSession(input: {
    agentSessionId: string;
    hostPaneId: string;
    executionId: string;
    state: AgentStatus;
    recentOutput?: string;
  }): Promise<void> {
    const response = await this.request({ type: "observe_agent_session", ...input });
    if (
      response.type !== "agent_session_observed" ||
      response.agentSessionId !== input.agentSessionId ||
      response.hostPaneId !== input.hostPaneId ||
      response.executionId !== input.executionId ||
      response.state !== input.state
    ) {
      throw unexpectedResponse("agent_session_observed", response.type);
    }
  }

  public async releaseAgentSession(input: {
    agentSessionId: string;
    hostPaneId: string;
    executionId: string;
  }): Promise<void> {
    const response = await this.request({ type: "release_agent_session", ...input });
    if (
      response.type !== "agent_session_released" ||
      response.agentSessionId !== input.agentSessionId ||
      response.hostPaneId !== input.hostPaneId ||
      response.executionId !== input.executionId
    ) {
      throw unexpectedResponse("agent_session_released", response.type);
    }
  }

  public close(): void {
    this.closed = true;
    for (const controller of this.activeAgentExecutions.values()) controller.abort();
    this.activeAgentExecutions.clear();
    this.failResponses(new PairingControlError("muximod control socket closed", "control_socket_closed"));
    this.reader.close();
    this.socket.destroy();
  }

  private async request(request: MuximodControlCommand): Promise<MuximodControlResponse> {
    const requestWithId = { ...request, requestId: randomUUID() } as MuximodControlRequest;
    const operation = this.requestQueue.then(async () => {
      this.socket.write(`${encodeMuximodControlRequest(requestWithId)}\n`);
      const response = await this.nextResponseFor(requestWithId.requestId);
      if (response.type === "error") throw controlError(response);
      return response;
    });
    this.requestQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async nextResponseFor(requestId: string): Promise<MuximodControlResponse> {
    while (true) {
      const response = await this.nextResponse();
      if (response.type === "pairing_claimed") {
        this.pendingClaims.push(response);
        continue;
      }
      if (response.type === "error" && response.requestId === undefined) {
        throw new PairingControlError(
          "muximod control socket returned an uncorrelated error response",
          "invalid_control_response",
        );
      }
      if (response.requestId !== requestId) {
        throw new PairingControlError(
          `muximod control response ${response.type} did not match request ${requestId}`,
          "control_response_mismatch",
        );
      }
      return response;
    }
  }

  private async handleAgentExecution(request: AgentExecutionStart): Promise<void> {
    const controller = new AbortController();
    this.activeAgentExecutions.set(request.requestId, controller);
    let result: AgentExecutionResult;
    try {
      if (!this.options.onAgentExecution) throw new Error("no agent execution handler is registered");
      result = await this.options.onAgentExecution(request, controller.signal);
    } catch (error) {
      result = {
        started: false,
        code: 127,
        interrupted: controller.signal.aborted,
        signal: null,
        failureDiagnostic:
          sanitizeProcessDiagnostic(error instanceof Error ? error.message : String(error)) ?? "agent execution failed",
      };
    }
    if (this.closed || this.socket.destroyed) {
      this.activeAgentExecutions.delete(request.requestId);
      return;
    }
    try {
      await this.request({
        type: "complete_agent_execution",
        executionRequestId: request.requestId,
        token: request.token,
        executionId: request.executionId,
        result,
      });
    } catch (error) {
      this.socket.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.activeAgentExecutions.delete(request.requestId);
    }
  }

  private async nextResponse(): Promise<MuximodControlResponse> {
    if (this.socketError) throw this.socketError;
    const response = this.responseQueue.shift();
    if (response) return response;
    return new Promise<MuximodControlResponse>((resolve, reject) => {
      this.responseWaiters.push({ resolve, reject });
    });
  }

  private async readResponses(): Promise<void> {
    try {
      for await (const line of this.responses) {
        if (Buffer.byteLength(line, "utf8") > muximodControlMaxResponseBytes) {
          throw new PairingControlError(
            "muximod control socket returned an oversized response",
            "invalid_control_response",
          );
        }
        const parsed = decodeMuximodControlResponse(line);
        if (!parsed.ok) {
          throw new PairingControlError(
            `muximod control socket returned ${parsed.message}`,
            "invalid_control_response",
          );
        }
        if (parsed.value.type === "execute_agent_process") {
          // AgentExecutionBroker allows one reservation per control peer. Keep
          // the same invariant here and fail closed if the daemon violates it.
          if (this.activeAgentExecutions.size > 0) {
            this.socket.destroy(
              new PairingControlError(
                "muximod sent concurrent agent execution requests on one control connection",
                "concurrent_agent_execution",
              ),
            );
            continue;
          }
          void this.handleAgentExecution(parsed.value);
          continue;
        }
        const waiter = this.responseWaiters.shift();
        if (waiter) waiter.resolve(parsed.value);
        else this.responseQueue.push(parsed.value);
      }
      this.failResponses(new PairingControlError("muximod control socket closed", "control_socket_closed"));
    } catch (error) {
      const failure =
        error instanceof PairingControlError
          ? error
          : new PairingControlError(
              `muximod control socket failed: ${error instanceof Error ? error.message : String(error)}`,
              "control_socket_error",
            );
      this.failResponses(failure);
    }
  }

  private failResponses(error: PairingControlError): void {
    if (this.socketError) return;
    this.socketError = error;
    for (const waiter of this.responseWaiters.splice(0)) waiter.reject(error);
  }
}

function connectControlSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!existsSync(path)) {
      reject(new PairingControlError(`muximod control socket does not exist: ${path}`, "control_socket_missing"));
      return;
    }
    const socket = createConnection(path);
    const onError = (error: Error) =>
      (() => {
        socket.destroy();
        reject(
          new PairingControlError(
            `could not connect to muximod control socket: ${error.message}`,
            "control_socket_connect_failed",
          ),
        );
      })();
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
    socket.once("error", onError);
  });
}

function controlError(response: Extract<MuximodControlResponse, { type: "error" }>): PairingControlError {
  return new PairingControlError(`${response.code}: ${response.message}`, response.code);
}

function toPairingClaim(response: Extract<MuximodControlResponse, { type: "pairing_claimed" }>): PairingClaim {
  return {
    pairingId: response.pairingId,
    serverId: response.serverId,
    deviceName: response.deviceName,
    deviceType: response.deviceType,
    platform: response.platform,
    clientVersion: response.clientVersion,
    keyFingerprint: response.keyFingerprint,
    expiresAt: response.expiresAt,
  };
}

function unexpectedResponse(expected: string, received: MuximodControlResponse["type"]): PairingControlError {
  return new PairingControlError(`expected ${expected} response, received ${received}`, "unexpected_control_response");
}
