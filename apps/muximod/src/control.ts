import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AuthPairingClaimNotification, MuximodAuthControlPort } from "@muximo/application";
import {
  decodeMuximodControlRequest,
  encodeMuximodControlResponse,
  encodePairingCode,
  type MuximodControlResponse,
} from "@muximo/contract";
import type { PaneState } from "@muximo/domain";
import { validateMuximodControlSocketPath } from "@muximo/infrastructure";

type AgentSessionControlRequest = {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
};

type AgentSessionObservationRequest = AgentSessionControlRequest & {
  state: PaneState;
  recentOutput?: string;
};

export type MuximodControlServerOptions = {
  socketPath: string;
  auth: MuximodAuthControlPort;
  adoptAgentSession?: (request: AgentSessionControlRequest) => Promise<void>;
  observeAgentSession?: (request: AgentSessionObservationRequest) => Promise<void>;
  releaseAgentSession?: (request: AgentSessionControlRequest) => Promise<void>;
};

export class MuximodControlServer {
  private readonly clients = new Set<Socket>();
  private readonly pairingOwners = new Map<string, Socket>();
  private server: Server | undefined;
  private started = false;

  public constructor(private readonly options: MuximodControlServerOptions) {}

  public start(): Promise<void> {
    ensureSocketPathIsSafe(this.options.socketPath);
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    this.server = createServer((socket) => this.handleConnection(socket));
    return new Promise((resolve, reject) => {
      const server = this.server;
      if (!server) throw new Error("control server was not initialized");
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        this.server = undefined;
        if (server.listening) server.close();
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        try {
          chmodSync(this.options.socketPath, 0o600);
          this.started = true;
          resolve();
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.socketPath);
    });
  }

  public stop(): void {
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
    if (this.started && existsSync(this.options.socketPath)) unlinkSync(this.options.socketPath);
    this.started = false;
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim()) void this.handleRequest(socket, line);
      }
    });
    socket.on("close", () => {
      this.clients.delete(socket);
      for (const [pairingId, owner] of this.pairingOwners) {
        if (owner !== socket) continue;
        this.pairingOwners.delete(pairingId);
        void this.options.auth.rejectPairing(pairingId).catch(() => {
          // The pairing may already have been approved, rejected, or expired.
        });
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private async handleRequest(socket: Socket, line: string): Promise<void> {
    const parsedRequest = decodeMuximodControlRequest(line);
    if (!parsedRequest.ok) {
      this.send(socket, {
        type: "error",
        code: "invalid_request",
        message: `control request ${parsedRequest.message}`,
      });
      return;
    }
    const request = parsedRequest.value;

    try {
      if (request.type === "create_pairing") {
        const payload = await this.options.auth.createPairing({ muximodBaseUrl: request.muximodBaseUrl });
        this.pairingOwners.set(payload.pairingId, socket);
        this.send(socket, {
          type: "pairing_created",
          pairingId: payload.pairingId,
          pairingCode: pairingPayloadCode(payload),
          payload,
        });
        return;
      }
      if (request.type === "approve_pairing") {
        const device = await this.options.auth.approvePairing(request.pairingId);
        this.send(socket, {
          type: "pairing_result",
          pairingId: request.pairingId,
          status: "approved",
          deviceId: device.deviceId,
        });
        return;
      }
      if (request.type === "reject_pairing") {
        await this.options.auth.rejectPairing(request.pairingId);
        this.send(socket, { type: "pairing_result", pairingId: request.pairingId, status: "rejected" });
        return;
      }
      if (request.type === "adopt_agent_session") {
        if (!this.options.adoptAgentSession)
          throw controlError("agent_session_adoption_unavailable", "agent session adoption is unavailable");
        void this.options
          .adoptAgentSession(toApplicationAgentSessionRequest(request))
          .then(() => this.send(socket, { ...request, type: "agent_session_adopted" }))
          .catch((error) =>
            this.send(socket, {
              type: "error",
              code: errorCode(error),
              message: errorMessage(error),
            }),
          );
        return;
      }
      if (request.type === "release_agent_session") {
        if (!this.options.releaseAgentSession)
          throw controlError("agent_session_release_unavailable", "agent session release is unavailable");
        void this.options
          .releaseAgentSession(toApplicationAgentSessionRequest(request))
          .then(() => this.send(socket, { ...request, type: "agent_session_released" }))
          .catch((error) =>
            this.send(socket, {
              type: "error",
              code: errorCode(error),
              message: errorMessage(error),
            }),
          );
        return;
      }
      if (request.type === "observe_agent_session") {
        if (!this.options.observeAgentSession)
          throw controlError("agent_session_observation_unavailable", "agent session observation is unavailable");
        void this.options
          .observeAgentSession(toApplicationAgentSessionObservationRequest(request))
          .then(() =>
            this.send(socket, {
              type: "agent_session_observed",
              agentSessionId: request.agentSessionId,
              hostPaneId: request.hostPaneId,
              executionId: request.executionId,
              state: request.state,
            }),
          )
          .catch((error) =>
            this.send(socket, {
              type: "error",
              code: errorCode(error),
              message: errorMessage(error),
            }),
          );
        return;
      }
      this.send(socket, { type: "error", code: "unknown_request", message: "unknown control request" });
    } catch (error) {
      this.send(socket, {
        type: "error",
        code: errorCode(error),
        message: errorMessage(error),
      });
    }
  }

  public notifyPairingClaim(notification: AuthPairingClaimNotification): void {
    const owner = this.pairingOwners.get(notification.pairingId);
    if (owner && !owner.destroyed) {
      this.send(owner, {
        type: "pairing_claimed",
        ...notification,
        platform: notification.platform ?? null,
        clientVersion: notification.clientVersion ?? null,
      });
    }
  }

  private send(socket: Socket, response: MuximodControlResponse): void {
    if (!socket.destroyed) socket.write(`${encodeMuximodControlResponse(response)}\n`);
  }
}

function pairingPayloadCode(payload: Parameters<typeof encodePairingCode>[0]): string {
  return encodePairingCode(payload);
}

function ensureSocketPathIsSafe(path: string): void {
  validateMuximodControlSocketPath(path);
  if (!path || path === "/" || path.endsWith("/")) throw new Error(`invalid muximod control socket path: ${path}`);
  if (existsSync(path) && !lstatSync(path).isSocket())
    throw new Error(`muximod control socket path is not a socket: ${path}`);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    if (error.code === "terminal_host_unavailable") return "tmux_unavailable";
    if (error.code === "terminal_host_pane_not_found") return "tmux_pane_not_found";
    return error.code;
  }
  return "control_error";
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "terminal host is unavailable") return "tmux is unavailable";
  if (message.startsWith("terminal host pane not found: ")) return message.replace("terminal host ", "tmux ");
  return message;
}

function toApplicationAgentSessionRequest(request: {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
}): AgentSessionControlRequest {
  return {
    agentSessionId: request.agentSessionId,
    hostPaneId: request.hostPaneId,
    executionId: request.executionId,
  };
}

function toApplicationAgentSessionObservationRequest(request: {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
  state: PaneState;
  recentOutput?: string;
}): AgentSessionObservationRequest {
  return {
    ...toApplicationAgentSessionRequest(request),
    state: request.state,
    ...(request.recentOutput === undefined ? {} : { recentOutput: request.recentOutput }),
  };
}

function controlError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
