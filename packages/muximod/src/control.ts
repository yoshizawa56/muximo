import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { AuthPairingClaimNotification, MuximodAuthControlPort } from "@muximo/application";
import {
  decodeMuximodControlRequest,
  encodeMuximodControlResponse,
  type MuximodControlLogResult,
  type MuximodControlRequest,
  type MuximodControlResponse,
  muximodControlMaxBufferedResponseBytes,
  muximodControlMaxPendingRequests,
  muximodControlMaxRequestBytes,
  muximodControlMaxResponseBytes,
} from "@muximo/contract/control";
import { encodePairingCode } from "@muximo/contract/shared";
import type { PaneState } from "@muximo/domain";
import type {
  AgentExecutionControlPeer,
  AgentExecutionReservation,
  AgentExecutionReservationInput,
} from "./agent-execution.js";
import { validateMuximodControlSocketPath } from "./client-paths.js";

const maxControlChunkBytes = muximodControlMaxRequestBytes * muximodControlMaxPendingRequests;

type AgentSessionControlRequest = {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
};

type AgentSessionObservationRequest = AgentSessionControlRequest & {
  state: PaneState;
  recentOutput?: string;
};

type AgentExecutionCompletionRequest = Extract<MuximodControlRequest, { type: "complete_agent_execution" }>;

export type MuximodControlServerOptions = {
  socketPath: string;
  auth: MuximodAuthControlPort;
  readLog?: (lines: number) => Promise<MuximodControlLogResult>;
  adoptAgentSession?: (request: AgentSessionControlRequest) => Promise<void>;
  observeAgentSession?: (request: AgentSessionObservationRequest) => Promise<void>;
  releaseAgentSession?: (request: AgentSessionControlRequest) => Promise<void>;
  reserveAgentExecution?: (
    peer: AgentExecutionControlPeer,
    request: AgentExecutionReservationInput,
  ) => Promise<AgentExecutionReservation> | AgentExecutionReservation;
  releaseAgentExecution?: (peer: AgentExecutionControlPeer, token: string) => Promise<void> | void;
  completeAgentExecution?: (
    peer: AgentExecutionControlPeer,
    request: AgentExecutionCompletionRequest,
  ) => Promise<void> | void;
  closeAgentExecution?: (peer: AgentExecutionControlPeer) => Promise<void> | void;
};

export class MuximodControlServer {
  private readonly clients = new Set<Socket>();
  private readonly pairingOwners = new Map<string, Socket>();
  private readonly peers = new Map<object, AgentExecutionControlPeer>();
  private server: Server | undefined;
  private socketPath: string | undefined;
  private started = false;
  private stopPromise: Promise<void> | undefined;

  public constructor(private readonly options: MuximodControlServerOptions) {}

  public async start(): Promise<void> {
    if (this.stopPromise) throw new Error("muximod control server has already stopped");
    if (this.started || this.server) throw new Error("muximod control server is already started");
    ensureSocketPathIsSafe(this.options.socketPath);
    const requestedSocketPath = resolve(this.options.socketPath);
    const privateDirectory = ensurePrivateDirectory(dirname(requestedSocketPath));
    const socketPath = join(privateDirectory, basename(requestedSocketPath));
    this.socketPath = socketPath;
    await removeStaleSocket(socketPath);
    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      let ownsSocket = false;
      if (!server) throw new Error("control server was not initialized");
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        this.server = undefined;
        if (server.listening) server.close();
        let cleanupError: unknown;
        if (ownsSocket) {
          try {
            removeSocketFile(socketPath);
          } catch (candidate) {
            cleanupError = candidate;
          }
        }
        this.socketPath = undefined;
        reject(
          cleanupError === undefined
            ? error
            : new Error("muximod control server failed and its socket could not be cleaned up", {
                cause: new AggregateError([error, cleanupError]),
              }),
        );
      };
      const onListening = () => {
        ownsSocket = true;
        server.removeListener("error", onError);
        try {
          chmodSync(socketPath, 0o600);
          this.started = true;
          resolve();
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      };

      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(socketPath);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    const server = this.server;
    const socketPath = this.socketPath ?? resolve(this.options.socketPath);
    const shouldRemoveSocket = this.started;
    for (const client of this.clients) client.destroy();
    this.clients.clear();
    this.pairingOwners.clear();
    this.peers.clear();
    this.server = undefined;
    this.socketPath = undefined;
    this.started = false;

    const cleanup = async (): Promise<void> => {
      const cleanupErrors: unknown[] = [];
      if (server?.listening) {
        try {
          await new Promise<void>((resolvePromise, reject) => {
            server.close((error) => (error ? reject(error) : resolvePromise()));
          });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (shouldRemoveSocket) {
        try {
          removeSocketFile(socketPath);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "muximod control cleanup failed");
    };
    this.stopPromise = cleanup();
    return this.stopPromise;
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    const peer = this.peerFor(socket);
    let buffer = "";
    let requestQueue = Promise.resolve();
    let pendingRequests = 0;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (Buffer.byteLength(chunk, "utf8") > maxControlChunkBytes) {
        socket.destroy(new Error("muximod control request chunk is too large"));
        return;
      }
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (Buffer.byteLength(line, "utf8") > muximodControlMaxRequestBytes) {
          socket.destroy(new Error("muximod control request is too large"));
          return;
        }
        if (line.trim()) {
          if (pendingRequests >= muximodControlMaxPendingRequests) {
            socket.destroy(new Error("too many pending muximod control requests"));
            return;
          }
          pendingRequests += 1;
          requestQueue = requestQueue
            .then(() => this.handleRequest(socket, line))
            .catch(() => undefined)
            .finally(() => {
              pendingRequests -= 1;
            });
        }
      }
      if (Buffer.byteLength(buffer, "utf8") > muximodControlMaxRequestBytes) {
        socket.destroy(new Error("muximod control request is too large"));
      }
    });
    socket.on("close", () => {
      this.clients.delete(socket);
      this.peers.delete(socket);
      void this.options.closeAgentExecution?.(peer);
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
    if (socket.destroyed || socket.writableEnded) return;
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
    const peer = this.peerFor(socket);

    try {
      if (request.type === "create_local_session") {
        this.send(socket, {
          type: "local_session_created",
          requestId: request.requestId,
          session: await this.options.auth.createLocalSession(),
        });
        return;
      }
      if (request.type === "create_pairing") {
        const payload = await this.options.auth.createPairing({ muximodBaseUrl: request.muximodBaseUrl });
        if (socket.destroyed || socket.writableEnded) {
          await this.options.auth.rejectPairing(payload.pairingId).catch(() => {
            // The pairing may already have expired while the client disconnected.
          });
          return;
        }
        this.pairingOwners.set(payload.pairingId, socket);
        this.send(socket, {
          type: "pairing_created",
          requestId: request.requestId,
          pairingId: payload.pairingId,
          pairingCode: pairingPayloadCode(payload),
          payload,
        });
        return;
      }
      if (request.type === "read_log") {
        if (!this.options.readLog) throw controlError("log_read_unavailable", "daemon log reading is unavailable");
        const result = await this.options.readLog(request.lines);
        this.send(socket, { type: "daemon_log", requestId: request.requestId, ...result, lines: [...result.lines] });
        return;
      }
      if (request.type === "reserve_agent_execution") {
        if (!this.options.reserveAgentExecution)
          throw controlError("agent_execution_unavailable", "agent execution is unavailable");
        const reservation = await this.options.reserveAgentExecution(peer, {
          operation: request.operation,
          ...(request.hostPaneId === undefined ? {} : { hostPaneId: request.hostPaneId }),
          ownerPid: request.ownerPid,
        });
        this.send(socket, {
          type: "agent_execution_reserved",
          requestId: request.requestId,
          token: reservation.token,
          ownerPid: reservation.ownerPid,
        });
        return;
      }
      if (request.type === "release_agent_execution") {
        if (!this.options.releaseAgentExecution)
          throw controlError("agent_execution_unavailable", "agent execution is unavailable");
        await this.options.releaseAgentExecution(peer, request.token);
        this.send(socket, {
          type: "agent_execution_released",
          requestId: request.requestId,
          token: request.token,
        });
        return;
      }
      if (request.type === "complete_agent_execution") {
        if (!this.options.completeAgentExecution)
          throw controlError("agent_execution_unavailable", "agent execution is unavailable");
        await this.options.completeAgentExecution(peer, request);
        this.send(socket, {
          type: "agent_execution_completed",
          requestId: request.requestId,
          executionRequestId: request.executionRequestId,
          token: request.token,
          executionId: request.executionId,
        });
        return;
      }
      if (request.type === "approve_pairing") {
        const device = await this.options.auth.approvePairing(request.pairingId);
        this.pairingOwners.delete(request.pairingId);
        this.send(socket, {
          type: "pairing_result",
          requestId: request.requestId,
          pairingId: request.pairingId,
          status: "approved",
          deviceId: device.deviceId,
        });
        return;
      }
      if (request.type === "reject_pairing") {
        await this.options.auth.rejectPairing(request.pairingId);
        this.pairingOwners.delete(request.pairingId);
        this.send(socket, {
          type: "pairing_result",
          requestId: request.requestId,
          pairingId: request.pairingId,
          status: "rejected",
        });
        return;
      }
      if (request.type === "adopt_agent_session") {
        if (!this.options.adoptAgentSession)
          throw controlError("agent_session_adoption_unavailable", "agent session adoption is unavailable");
        await this.options.adoptAgentSession(toApplicationAgentSessionRequest(request));
        this.send(socket, { ...request, type: "agent_session_adopted" });
        return;
      }
      if (request.type === "release_agent_session") {
        if (!this.options.releaseAgentSession)
          throw controlError("agent_session_release_unavailable", "agent session release is unavailable");
        await this.options.releaseAgentSession(toApplicationAgentSessionRequest(request));
        this.send(socket, { ...request, type: "agent_session_released" });
        return;
      }
      if (request.type === "observe_agent_session") {
        if (!this.options.observeAgentSession)
          throw controlError("agent_session_observation_unavailable", "agent session observation is unavailable");
        await this.options.observeAgentSession(toApplicationAgentSessionObservationRequest(request));
        this.send(socket, {
          type: "agent_session_observed",
          requestId: request.requestId,
          agentSessionId: request.agentSessionId,
          hostPaneId: request.hostPaneId,
          executionId: request.executionId,
          state: request.state,
        });
        return;
      }
      this.send(socket, {
        type: "error",
        code: "unknown_request",
        message: "unknown control request",
      });
    } catch (error) {
      this.send(socket, {
        type: "error",
        requestId: request.requestId,
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
    if (socket.destroyed) return;
    const frame = `${encodeMuximodControlResponse(response)}\n`;
    if (Buffer.byteLength(frame, "utf8") > muximodControlMaxResponseBytes) {
      socket.destroy(new Error("muximod control response is too large"));
      return;
    }
    if ((socket.writableLength ?? 0) + Buffer.byteLength(frame, "utf8") > muximodControlMaxBufferedResponseBytes) {
      socket.destroy(new Error("muximod control response buffer is too large"));
      return;
    }
    socket.write(frame);
  }

  private peerFor(socket: Socket): AgentExecutionControlPeer {
    const existing = this.peers.get(socket);
    if (existing) return existing;
    const peer: AgentExecutionControlPeer = {
      isOpen: () => !socket.destroyed && !socket.writableEnded,
      send: (response) => this.send(socket, response),
    };
    this.peers.set(socket, peer);
    return peer;
  }
}

function pairingPayloadCode(payload: Parameters<typeof encodePairingCode>[0]): string {
  return encodePairingCode(payload);
}

function ensureSocketPathIsSafe(path: string): void {
  if (path.includes("\u0000")) throw new Error("muximod control socket path must not contain NUL bytes");
  validateMuximodControlSocketPath(path);
  const resolvedPath = resolve(path);
  validateMuximodControlSocketPath(resolvedPath);
  if (!path || path.endsWith("/") || path.endsWith("\\") || resolvedPath === "/" || resolvedPath.endsWith(sep)) {
    throw new Error(`invalid muximod control socket path: ${path}`);
  }
  if (existsSync(resolvedPath) && !lstatSync(resolvedPath).isSocket())
    throw new Error(`muximod control socket path is not a socket: ${path}`);
}

function ensurePrivateDirectory(path: string): string {
  const absolutePath = resolve(path);
  const segments = absolutePath.split(sep).filter(Boolean);
  let current = absolutePath.startsWith(sep) ? sep : "";
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const target = realpathSync(current);
        if (!isAllowedSystemDirectoryAlias(current, target)) {
          throw new Error(`muximod control socket parent is a symbolic link: ${current}`);
        }
        current = target;
        const targetStat = lstatSync(current);
        if (!targetStat.isDirectory()) {
          throw new Error(`muximod control socket parent is not a private directory: ${current}`);
        }
        assertPrivateDirectoryMode(current, index === segments.length - 1);
        continue;
      }
      if (!stat.isDirectory()) {
        throw new Error(`muximod control socket parent is not a private directory: ${current}`);
      }
      assertPrivateDirectoryMode(current, index === segments.length - 1);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
      mkdirSync(current, { mode: 0o700 });
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`muximod control socket parent is not a private directory: ${current}`);
      }
      chmodSync(current, 0o700);
    }
  }
  if (current === sep || !current) throw new Error(`muximod control socket parent must be private: ${path}`);
  if (isSystemDirectory(current)) throw new Error(`muximod control socket parent must be private: ${path}`);
  assertPrivateDirectoryMode(current, true);
  return current;
}

function assertPrivateDirectoryMode(path: string, isFinal: boolean): void {
  if (isSystemDirectory(path)) {
    if (isFinal) throw new Error(`muximod control socket parent must be private: ${path}`);
    return;
  }
  const mode = lstatSync(path).mode & 0o777;
  if ((mode & 0o022) !== 0) {
    throw new Error(`muximod control socket parent must not be group- or world-writable: ${path}`);
  }
  if (isFinal && mode !== 0o700) {
    chmodSync(path, 0o700);
    const privateMode = lstatSync(path).mode & 0o777;
    if (privateMode !== 0o700) {
      throw new Error(`muximod control socket parent must be owner-only: ${path}`);
    }
  }
}

/**
 * The private socket uses the owner-only socket and parent-directory modes as
 * its peer boundary. Node's portable net API does not expose peer credentials
 * consistently, so this control channel intentionally trusts processes from
 * the same operating-system account and is never a public transport.
 */
function isSystemDirectory(path: string): boolean {
  return process.platform === "darwin"
    ? path === "/tmp" || path === "/private/tmp" || path === "/var" || path === "/private/var"
    : path === "/tmp" || path === "/var";
}

function isAllowedSystemDirectoryAlias(path: string, target: string): boolean {
  if (process.platform !== "darwin") return false;
  return (
    (path === "/var" && target === "/private/var") ||
    (path === "/tmp" && target === "/private/tmp") ||
    (path === "/etc" && target === "/private/etc")
  );
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;

  if (await controlSocketIsActive(path)) {
    const error = new Error(`muximod control socket is already in use: ${path}`) as NodeJS.ErrnoException;
    error.code = "EADDRINUSE";
    throw error;
  }

  try {
    if (lstatSync(path).isSocket()) unlinkSync(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function removeSocketFile(path: string): void {
  try {
    if (existsSync(path) && lstatSync(path).isSocket()) unlinkSync(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function controlSocketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(active);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      if (isStaleSocketError(error)) {
        finish(false);
        return;
      }
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    });
  });
}

function isStaleSocketError(error: unknown): boolean {
  return isErrorCode(error, "ECONNREFUSED") || isErrorCode(error, "ENOENT");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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
