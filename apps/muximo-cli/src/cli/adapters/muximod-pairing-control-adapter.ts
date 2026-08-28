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

type AgentStatus = Extract<MuximodControlRequest, { type: "observe_agent_session" }>["state"];
type MuximodControlCommand = MuximodControlRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId">
    : never
  : never;

export class PairingControlError extends Error {
  public constructor(
    message: string,
    public readonly code = "pairing_control_error",
  ) {
    super(message);
    this.name = "PairingControlError";
  }
}

/** Unix-socket adapter for muximod's private pairing and pane control protocol. */
export class MuximodPairingControlAdapter implements PairingControlPort {
  private readonly reader: Interface;
  private readonly responses: AsyncIterator<string>;
  private requestQueue: Promise<void> = Promise.resolve();
  private readonly pendingClaims: Extract<MuximodControlResponse, { type: "pairing_claimed" }>[] = [];
  private socketError: PairingControlError | undefined;

  private constructor(private readonly socket: Socket) {
    socket.on("error", (error) => {
      this.socketError = new PairingControlError(
        `muximod control socket failed: ${error.message}`,
        "control_socket_error",
      );
    });
    this.reader = createInterface({ input: socket, crlfDelay: Infinity });
    this.responses = this.reader[Symbol.asyncIterator]();
  }

  public static async connect(socketPath: string): Promise<MuximodPairingControlAdapter> {
    return new MuximodPairingControlAdapter(await connectControlSocket(socketPath));
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

  private async nextResponse(): Promise<MuximodControlResponse> {
    if (this.socketError) throw this.socketError;
    let next: IteratorResult<string>;
    try {
      next = await this.responses.next();
    } catch (error) {
      throw new PairingControlError(
        `muximod control socket failed: ${error instanceof Error ? error.message : String(error)}`,
        "control_socket_error",
      );
    }
    if (this.socketError) throw this.socketError;
    if (next.done)
      throw new PairingControlError("muximod control socket closed before pairing completed", "control_socket_closed");
    if (Buffer.byteLength(next.value, "utf8") > muximodControlMaxResponseBytes) {
      throw new PairingControlError(
        "muximod control socket returned an oversized response",
        "invalid_control_response",
      );
    }
    const parsed = decodeMuximodControlResponse(next.value);
    if (!parsed.ok)
      throw new PairingControlError(`muximod control socket returned ${parsed.message}`, "invalid_control_response");
    return parsed.value;
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
