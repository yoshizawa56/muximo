import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { validateMuximodControlSocketPath } from "@muximo/infrastructure";
import type { AuthPairingClaimNotification, MuximodAuthControlPort } from "@muximo/application";
import {
  decodeMuximodControlRequest,
  encodeMuximodControlResponse,
  encodePairingCode,
  type MuximodControlResponse,
} from "@muximo/contract";
import type { PaneState } from "@muximo/domain";

export type MuximodControlServerOptions = {
  socketPath: string;
  auth: MuximodAuthControlPort;
  adoptAgentSession?: (request: { agentSessionId: string; tmuxPaneId: string; executionId: string }) => Promise<void>;
  observeAgentSession?: (request: { agentSessionId: string; tmuxPaneId: string; executionId: string; state: PaneState; recentOutput?: string }) => Promise<void>;
  releaseAgentSession?: (request: { agentSessionId: string; tmuxPaneId: string; executionId: string }) => Promise<void>;
};

export class MuximodControlServer {
  private readonly clients = new Set<Socket>();
  private readonly pairingOwners = new Map<string, Socket>();
  private server: Server | undefined;
  private started = false;

  public constructor(private readonly options: MuximodControlServerOptions) {
    this.options.auth.setPairingClaimListener((notification) => this.notifyClaim(notification));
  }

  public start(): Promise<void> {
    ensureSocketPathIsSafe(this.options.socketPath);
    mkdirSync(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
    this.server = createServer((socket) => this.handleConnection(socket));
    return new Promise((resolve, reject) => {
      const server = this.server!;
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
        if (line.trim()) this.handleRequest(socket, line);
      }
    });
    socket.on("close", () => {
      this.clients.delete(socket);
      for (const [pairingId, owner] of this.pairingOwners) {
        if (owner !== socket) continue;
        this.pairingOwners.delete(pairingId);
        try {
          this.options.auth.rejectPairing(pairingId);
        } catch {
          // The pairing may already have been approved, rejected, or expired.
        }
      }
    });
    socket.on("error", () => socket.destroy());
  }

  private handleRequest(socket: Socket, line: string): void {
    const parsedRequest = decodeMuximodControlRequest(line);
    if (!parsedRequest.ok) {
      this.send(socket, { type: "error", code: "invalid_request", message: `control request ${parsedRequest.message}` });
      return;
    }
    const request = parsedRequest.value;

    try {
      if (request.type === "create_pairing") {
        const payload = this.options.auth.createPairing({ muximodBaseUrl: request.muximodBaseUrl });
        this.pairingOwners.set(payload.pairingId, socket);
        this.send(socket, { type: "pairing_created", pairingId: payload.pairingId, pairingCode: pairingPayloadCode(payload), payload });
        return;
      }
      if (request.type === "approve_pairing") {
        const device = this.options.auth.approvePairing(request.pairingId);
        this.send(socket, { type: "pairing_result", pairingId: request.pairingId, status: "approved", deviceId: device.deviceId });
        return;
      }
      if (request.type === "reject_pairing") {
        this.options.auth.rejectPairing(request.pairingId);
        this.send(socket, { type: "pairing_result", pairingId: request.pairingId, status: "rejected" });
        return;
      }
      if (request.type === "adopt_agent_session") {
        if (!this.options.adoptAgentSession) throw controlError("agent_session_adoption_unavailable", "agent session adoption is unavailable");
        void this.options.adoptAgentSession(request)
          .then(() => this.send(socket, { ...request, type: "agent_session_adopted" }))
          .catch((error) => this.send(socket, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (request.type === "release_agent_session") {
        if (!this.options.releaseAgentSession) throw controlError("agent_session_release_unavailable", "agent session release is unavailable");
        void this.options.releaseAgentSession(request)
          .then(() => this.send(socket, { ...request, type: "agent_session_released" }))
          .catch((error) => this.send(socket, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (request.type === "observe_agent_session") {
        if (!this.options.observeAgentSession) throw controlError("agent_session_observation_unavailable", "agent session observation is unavailable");
        void this.options.observeAgentSession(request)
          .then(() => this.send(socket, { type: "agent_session_observed", agentSessionId: request.agentSessionId, tmuxPaneId: request.tmuxPaneId, executionId: request.executionId, state: request.state }))
          .catch((error) => this.send(socket, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) }));
        return;
      }
      this.send(socket, { type: "error", code: "unknown_request", message: "unknown control request" });
    } catch (error) {
      this.send(socket, { type: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
    }
  }

  private notifyClaim(notification: AuthPairingClaimNotification): void {
    const owner = this.pairingOwners.get(notification.pairingId);
    if (owner && !owner.destroyed) this.send(owner, { type: "pairing_claimed", ...notification });
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
  if (existsSync(path) && !lstatSync(path).isSocket()) throw new Error(`muximod control socket path is not a socket: ${path}`);
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "control_error";
}

function controlError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
