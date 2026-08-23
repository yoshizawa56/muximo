import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type CodexThreadOperation = "name" | "archive" | "unarchive";

type RpcMessage = {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string; [key: string]: unknown };
  [key: string]: unknown;
};

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Minimal Unix-socket WebSocket client for the Codex app-server control API.
 *
 * The dotfiles wrapper used a small Python implementation because the
 * app-server endpoint is a Unix socket rather than a TCP URL. Keeping this
 * transport here makes the migrated `muximo` command self-contained and also
 * retains the raw-frame fallback used by older app-server builds.
 */
export async function manageCodexThread(options: {
  threadId: string;
  operation: CodexThreadOperation;
  name?: string;
  socketPath?: string;
  transport?: "auto" | "http" | "raw";
}): Promise<void> {
  const socketPath = options.socketPath ?? defaultCodexSocket();
  const transport = options.transport ?? "auto";
  const client = await CodexRpcClient.connect(socketPath, transport);
  try {
    await client.initialize();
    if (options.operation === "name") {
      if (!options.name) throw new Error("Codex thread name is required");
      await client.request("thread/name/set", { threadId: options.threadId, name: options.name });
    } else if (options.operation === "archive") {
      await client.request("thread/archive", { threadId: options.threadId });
    } else {
      await client.request("thread/unarchive", { threadId: options.threadId });
    }
  } finally {
    client.close();
  }
}

export function defaultCodexSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

class CodexRpcClient {
  private readonly socket: Socket;
  private readonly websocket: boolean;
  private buffer: Buffer;
  private nextRequestId = 1;

  private constructor(socket: Socket, buffered: Buffer, websocket: boolean) {
    this.socket = socket;
    this.buffer = buffered;
    this.websocket = websocket;
  }

  public static async connect(path: string, transport: "auto" | "http" | "raw"): Promise<CodexRpcClient> {
    if (transport === "raw") return new CodexRpcClient(await openSocket(path), Buffer.alloc(0), false);

    const socket = await openSocket(path);
    try {
      const result = await performHandshake(socket);
      return new CodexRpcClient(socket, result.remaining, true);
    } catch (error) {
      socket.destroy();
      if (transport === "http") throw error;
      return new CodexRpcClient(await openSocket(path), Buffer.alloc(0), false);
    }
  }

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "muximo_wrapper", title: "muximo wrapper", version: "1" },
    });
    this.sendFrame(0x1, Buffer.from('{"method":"initialized","params":{}}', "utf8"));
  }

  public async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextRequestId++;
    this.sendFrame(0x1, Buffer.from(JSON.stringify({ id, method, params }), "utf8"));
    while (true) {
      const message = await this.receiveMessage();
      if (message.id !== id) continue;
      if (message.error) {
        throw new Error(`app-server ${method} failed: ${message.error.message ?? JSON.stringify(message.error)}`);
      }
      return message;
    }
  }

  public close(): void {
    if (this.websocket) {
      try {
        this.sendFrame(0x8, Buffer.alloc(0));
      } catch {
        // The server may already have closed the socket after the RPC response.
      }
    }
    this.socket.destroy();
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const mask = randomBytes(4);
    const length = payload.byteLength;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private async receiveMessage(): Promise<RpcMessage> {
    const fragments: Buffer[] = [];
    let messageOpcode: number | undefined;
    while (true) {
      const first = await this.readByte();
      const second = await this.readByte();
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      if (length === 126) length = (await this.readBytes(2)).readUInt16BE(0);
      if (length === 127) {
        const largeLength = (await this.readBytes(8)).readBigUInt64BE(0);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Codex frame is too large");
        length = Number(largeLength);
      }
      let mask: Buffer | undefined;
      if ((second & 0x80) !== 0) {
        mask = await this.readBytes(4);
        // Server frames should not be masked, but accepting them costs little
        // and mirrors the old helper's tolerant decoder.
      }
      let payload = await this.readBytes(length);
      if (mask) payload = unmask(payload, mask);

      if (opcode === 0x8) throw new Error("app-server closed the WebSocket");
      if (opcode === 0x9) {
        this.sendFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        messageOpcode = opcode;
        fragments.push(payload);
      } else if (opcode === 0x0 && messageOpcode !== undefined) {
        fragments.push(payload);
      } else {
        continue;
      }
      if (fin && messageOpcode !== undefined) {
        return JSON.parse(Buffer.concat(fragments).toString("utf8")) as RpcMessage;
      }
    }
  }

  private async readByte(): Promise<number> {
    return (await this.readBytes(1))[0]!;
  }

  private async readBytes(size: number): Promise<Buffer> {
    while (this.buffer.byteLength < size) {
      const chunk = await readChunk(this.socket);
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const result = Buffer.alloc(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) result[index] = payload[index]! ^ mask[index % 4]!;
  return result;
}

async function openSocket(path: string): Promise<Socket> {
  const socket = createConnection(path);
  socket.setTimeout(10_000);
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => onError(new Error("Codex app-server socket timed out"));
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
  return socket;
}

async function performHandshake(socket: Socket): Promise<{ remaining: Buffer }> {
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  while (!buffer.includes(Buffer.from("\r\n\r\n"))) {
    buffer = Buffer.concat([buffer, await readChunk(socket)]);
    if (buffer.byteLength > 65_536) throw new Error("Codex app-server WebSocket handshake is too large");
  }
  const delimiter = buffer.indexOf(Buffer.from("\r\n\r\n"));
  const header = buffer.subarray(0, delimiter).toString("latin1");
  const statusLine = header.split("\r\n", 1)[0] ?? "";
  if (!statusLine.includes(" 101 ")) throw new Error(`Codex app-server WebSocket handshake failed: ${statusLine}`);
  const headers = new Map<string, string>();
  for (const line of header.split("\r\n").slice(1)) {
    const separator = line.indexOf(":");
    if (separator !== -1) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const expected = createHash("sha1").update(`${key}${websocketGuid}`).digest("base64");
  if (headers.get("sec-websocket-accept") !== expected) throw new Error("Invalid Codex WebSocket accept key");
  return { remaining: buffer.subarray(delimiter + 4) };
}

function readChunk(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(Buffer.from(chunk));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => onError(new Error("Codex app-server socket closed unexpectedly"));
    const onTimeout = () => onError(new Error("Codex app-server socket timed out"));
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      socket.off("timeout", onTimeout);
    };
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("timeout", onTimeout);
  });
}
