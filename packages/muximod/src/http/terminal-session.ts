import { randomBytes } from "node:crypto";
import {
  type ClientControlMessage,
  decodeBase64,
  decodeClientControlFrame,
  encodeServerControlFrame,
  maxPasteImageBytes,
  type ServerControlMessage,
  terminalProtocolVersion,
} from "@muximo/contract/api";
import {
  type ImagePaster,
  type MuximodSocket,
  type MuximodSocketData,
  muximodSocketReadyState,
  type PreparedViewport,
  type PtyProcess,
  type PtySpawner,
  type TerminalViewportPort,
  type ViewportLease,
} from "@muximo/infrastructure/runtime";

type TerminalViewportManager = TerminalViewportPort;

const TERMINAL_OUTPUT_GAP_MAX_BYTES = 128 * 1024;

export type TerminalSessionOptions = {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  viewportManager: TerminalViewportManager;
  /** How long a transport can be absent before the PTY and lease are released. */
  resumeGraceMs?: number;
  /** The host PTY implementation is injected by the composition root. */
  spawnPty: PtySpawner;
  sessions?: TerminalSessionRegistry;
  authDeviceId?: string;
  /** Delivers pasted images into the attached tmux pane. */
  imagePaster?: ImagePaster;
};

/**
 * Keeps resumable terminal runtimes separate from their replaceable sockets.
 * A token is deliberately required in addition to the public session id so a
 * reconnect cannot attach to another browser's PTY by guessing an id.
 */
export class TerminalSessionRegistry {
  /**
   * Session identity and ownership lookups remain synchronous so a reconnect
   * cannot observe a partially updated in-memory registry entry.
   */
  private readonly sessions = new Map<string, TerminalSession>();

  public register(session: TerminalSession): void {
    const current = this.sessions.get(session.sessionId);
    if (current && current !== session) {
      throw new Error(`Terminal session id is already registered: ${session.sessionId}`);
    }
    this.sessions.set(session.sessionId, session);
  }

  public find(sessionId: string, resumeToken: string, authDeviceId?: string): TerminalSession | undefined {
    const session = this.sessions.get(sessionId);
    return session?.matchesResumeToken(resumeToken) && session.matchesAuthContext(authDeviceId) ? session : undefined;
  }

  public unregister(session: TerminalSession): void {
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
  }

  /**
   * Releases a parked session that blocks a fresh attach from the same
   * authenticated device. A same-target replacement is intentionally denied
   * without a device identity so an unauthenticated caller cannot evict a
   * resumable session by guessing its target.
   */
  public async releaseParkedForAttach(target: string, authDeviceId?: string): Promise<boolean> {
    let released = false;
    for (const session of [...this.sessions.values()]) {
      released = (await session.releaseIfParkedForAttach(target, authDeviceId)) || released;
    }
    return released;
  }

  public async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const results = await Promise.allSettled(sessions.map((session) => session.dispose()));
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "terminal session cleanup failed");
  }

  public get size(): number {
    return this.sessions.size;
  }
}

type TerminalSessionState = "awaiting_attach" | "attaching" | "attached" | "synchronizing" | "parked" | "closed";

type SocketBinding = {
  socket: MuximodSocket;
  removeMessageListener: () => void;
  removeCloseListener: () => void;
  removeErrorListener: () => void;
  generation: number;
};

type AttachMessage = Extract<ClientControlMessage, { type: "attach" }>;

export class TerminalSession {
  public readonly sessionId = opaqueId();

  private resumeToken = opaqueToken();
  private readonly registry: TerminalSessionRegistry;
  private readonly resumeGraceMs: number;
  private socket: MuximodSocket | undefined;
  private socketBinding: SocketBinding | undefined;
  private pty: PtyProcess | undefined;
  private lease: ViewportLease | undefined;
  private state: TerminalSessionState = "awaiting_attach";
  private disposed = false;
  private registered = false;
  private attachGeneration = 0;
  private transportGeneration = 0;
  private resumeTimer: NodeJS.Timeout | undefined;
  private target: string | undefined;
  private cols = 80;
  private rows = 24;
  private ptyCols = 80;
  private ptyRows = 24;
  private parkedOutput: Buffer[] = [];
  private parkedOutputBytes = 0;
  private parkedOutputOverflowed = false;
  private transportBackpressured = false;

  public constructor(
    socket: MuximodSocket,
    private readonly options: TerminalSessionOptions,
  ) {
    this.registry = options.sessions ?? new TerminalSessionRegistry();
    this.resumeGraceMs = Math.max(0, options.resumeGraceMs ?? 30_000);
    this.bindSocket(socket);
  }

  public matchesResumeToken(resumeToken: string): boolean {
    return !this.disposed && this.resumeToken === resumeToken;
  }

  public matchesAuthContext(authDeviceId?: string): boolean {
    return this.options.authDeviceId === authDeviceId;
  }

  public async releaseIfParkedForAttach(target: string, authDeviceId?: string): Promise<boolean> {
    if (!this.matchesAuthContext(authDeviceId) || this.state !== "parked") return false;
    if (this.target === target && !authDeviceId) return false;
    await this.finalizeTransport(1000, "replaced");
    return true;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;

    if (this.socket && this.state !== "awaiting_attach") {
      this.sendClosed("server_shutdown", null, null);
    }
    await this.finalizeTransport(1001, "muximod stopped");
  }

  private bindSocket(socket: MuximodSocket): void {
    const generation = ++this.transportGeneration;
    const onMessage = (data: MuximodSocketData, isBinary: boolean) => {
      if (this.socket !== socket || this.socketBinding?.generation !== generation || this.disposed) return;
      void this.handleMessage(data, isBinary).catch((error) => this.handleAsyncFailure(error));
    };
    const onClose = () => {
      if (this.socket !== socket || this.socketBinding?.generation !== generation) return;
      void this.handleTransportClosed().catch((error) => this.handleAsyncFailure(error));
    };
    const onError = (error: Error) => {
      // ws normally follows an error with close. If a test double or adapter
      // reports CLOSED without that follow-up, apply the same network-loss
      // transition here. An open socket is left alone so transient errors do
      // not release a healthy PTY.
      if (socket.readyState === muximodSocketReadyState.closed) {
        void this.handleTransportClosed().catch((error) => this.handleAsyncFailure(error));
      }
      void error;
    };

    const removeMessageListener = socket.onMessage(onMessage);
    const removeCloseListener = socket.onClose(onClose);
    const removeErrorListener = socket.onError(onError);
    this.socket = socket;
    this.socketBinding = { socket, removeMessageListener, removeCloseListener, removeErrorListener, generation };
  }

  private detachSocketListeners(): void {
    const binding = this.socketBinding;
    if (!binding) {
      this.socket = undefined;
      return;
    }

    binding.removeMessageListener();
    binding.removeCloseListener();
    binding.removeErrorListener();
    if (this.socket === binding.socket) this.socket = undefined;
    this.socketBinding = undefined;
  }

  private async handleMessage(data: MuximodSocketData, isBinary: boolean): Promise<void> {
    if (this.disposed) return;

    if (isBinary) {
      if (!this.isAttached()) {
        this.sendError("not_attached", "Attach before sending terminal input");
        return;
      }

      try {
        await this.claimMobileForInput(this.cols, this.rows);
        await this.pty?.write(rawDataToBuffer(data).toString("utf8"));
      } catch (error) {
        this.sendError("mobile_claim_failed", error);
      }
      return;
    }

    const decoded = decodeClientControlFrame(rawDataToBuffer(data));
    if (!decoded.ok) {
      this.sendError(decoded.code, decoded.message);
      return;
    }

    await this.handleControlMessage(decoded.message);
  }

  private async handleControlMessage(message: ClientControlMessage): Promise<void> {
    switch (message.type) {
      case "attach":
        await this.handleAttach(message);
        return;
      case "claim":
        if (!this.isAttached()) {
          this.sendError("not_attached", "Attach before claiming the viewport");
          return;
        }
        try {
          await this.claimMobileForInput(message.cols, message.rows);
          this.cols = message.cols;
          this.rows = message.rows;
        } catch (error) {
          this.sendError("mobile_claim_failed", error);
        }
        return;
      case "enter_copy_mode":
        if (!this.isAttached() || !this.lease) {
          this.sendError("not_attached", "Attach before entering tmux copy mode");
          return;
        }
        try {
          await this.claimMobileForInput(this.cols, this.rows);
          await this.lease.enterCopyMode();
        } catch (error) {
          this.sendError("copy_mode_failed", error);
        }
        return;
      case "paste_tmux_buffer":
        if (!this.isAttached() || !this.lease) {
          this.sendError("not_attached", "Attach before pasting the tmux buffer");
          return;
        }
        try {
          await this.claimMobileForInput(this.cols, this.rows);
          await this.lease.pasteTmuxBuffer();
        } catch (error) {
          this.sendError("paste_tmux_buffer_failed", error);
        }
        return;
      case "paste_image":
        await this.handlePasteImage(message);
        return;
      case "resize":
        if (!this.isAttached()) {
          this.sendError("not_attached", "Attach before resizing the terminal");
          return;
        }
        try {
          await this.lease?.resize(message.cols, message.rows);
          await this.pty?.resize(message.cols, message.rows);
          this.ptyCols = message.cols;
          this.ptyRows = message.rows;
          this.cols = message.cols;
          this.rows = message.rows;
        } catch (error) {
          this.sendError("resize_failed", error);
        }
        return;
      case "redraw":
        if (!this.isAttached() || !this.lease) {
          this.sendError("not_attached", "Attach before requesting a terminal redraw");
          return;
        }
        try {
          await this.lease.refresh();
        } catch (error) {
          this.sendError("redraw_failed", error);
        }
        return;
      case "ping":
        this.send({ type: "pong", version: terminalProtocolVersion, nonce: message.nonce });
        return;
      case "detach":
        await this.detachIntentionally();
        return;
    }
  }

  private async handleAttach(message: AttachMessage): Promise<void> {
    if (this.state !== "awaiting_attach") {
      this.sendError("already_attached", "This WebSocket already has a terminal session");
      return;
    }

    if (message.sessionId && message.resumeToken) {
      const existing = this.registry.find(message.sessionId, message.resumeToken, this.options.authDeviceId);
      if (!existing) {
        this.sendError("resume_not_found", "The terminal session is no longer resumable", true);
        return;
      }
      if (!existing.canResumeTarget(message.target)) {
        this.sendError("resume_target_mismatch", "The resume target does not match the terminal session");
        return;
      }

      const socket = this.socket;
      if (!socket) return;
      // The new connection's temporary TerminalSession is currently handling
      // this message. Bind the replacement listener after that EventEmitter
      // dispatch completes, otherwise the same attach frame can be observed
      // twice by the resumed session.
      await Promise.resolve();
      if (!(await existing.resumeSocket(socket, message))) {
        this.sendError("resume_unavailable", "The terminal session is no longer available", true);
        return;
      }
      this.detachSocketListeners();
      this.disposed = true;
      this.state = "closed";
      return;
    }

    await this.attachFresh(message);
  }

  private canResumeTarget(target: string): boolean {
    return this.target === target && this.isAttachedOrParked();
  }

  private async resumeSocket(socket: MuximodSocket, message: AttachMessage): Promise<boolean> {
    if (this.disposed || !this.isAttachedOrParked() || !this.canResumeTarget(message.target)) return false;

    const previousSocket = this.socket;
    this.detachSocketListeners();
    if (previousSocket && previousSocket !== socket) closeSocket(previousSocket, 1000, "replaced");

    this.clearResumeTimer();
    this.bindSocket(socket);
    this.transportBackpressured = false;
    this.state = "synchronizing";
    this.cols = message.cols;
    this.rows = message.rows;
    let shouldRedraw = false;
    let replay: Buffer[] = [];

    try {
      // Resuming transport must preserve the server-side owner. A mobile
      // WebView may reconnect after a desktop takeover; its dimensions are
      // only a measurement until the user explicitly claims control.
      await this.lease?.resize(message.cols, message.rows);
      await this.pty?.resize(message.cols, message.rows);
      this.ptyCols = message.cols;
      this.ptyRows = message.rows;
      shouldRedraw = this.parkedOutputOverflowed;
      if (shouldRedraw) await this.lease?.refresh();
      replay = this.takeParkedOutput();
      this.clearParkedOutput();
      this.state = "attached";
    } catch (error) {
      this.sendError("resume_failed", error, true);
      // The replacement transport is already bound at this point. Keep the
      // runtime resumable, close the failed transport, and let the client run
      // through the normal bounded retry path instead of leaving the session
      // stuck in `synchronizing`.
      this.state = "parked";
      this.scheduleResumeExpiry();
      closeSocket(socket, 1013, "terminal resume failed");
      return true;
    }

    this.resumeToken = opaqueToken();
    this.sendReady(true, shouldRedraw ? "redraw" : "replay");
    for (const chunk of replay) this.sendBinary(chunk);
    return true;
  }

  private async attachFresh(message: AttachMessage): Promise<void> {
    const generation = ++this.attachGeneration;
    const target = message.target;
    this.state = "attaching";
    this.cols = message.cols;
    this.rows = message.rows;

    let prepared: PreparedViewport | undefined;
    let pty: PtyProcess | undefined;
    let lease: ViewportLease | undefined;
    let leaseReleased = false;
    let preparedReleased = false;

    const releaseLease = async (): Promise<void> => {
      if (!lease || leaseReleased) return;
      leaseReleased = true;
      try {
        await lease.release();
      } catch {
        // Preserve the attach failure; releasing a disappearing viewport is
        // best effort and the manager guards repeated release calls.
      }
    };
    const releasePrepared = async (): Promise<void> => {
      if (!prepared || preparedReleased) return;
      preparedReleased = true;
      try {
        await prepared.release();
      } catch {
        // Preserve the attach failure; preparation cleanup is best effort.
      }
    };

    try {
      try {
        prepared = await this.options.viewportManager.prepare(target, this.options.cwd, message.cols, message.rows);
      } catch (error) {
        if (
          !isViewportLeaseConflict(error) ||
          !(await this.registry.releaseParkedForAttach(target, this.options.authDeviceId))
        )
          throw error;
        prepared = await this.options.viewportManager.prepare(target, this.options.cwd, message.cols, message.rows);
      }
      const attachProcess = this.options.viewportManager.buildAttachProcess(prepared.attachTarget);
      pty = await this.options.spawnPty(attachProcess.file, attachProcess.args, {
        name: "xterm-256color",
        cols: message.cols,
        rows: message.rows,
        cwd: this.options.cwd,
        env: {
          ...stringEnvironment(this.options.environment ?? process.env),
          TERM: "xterm-256color",
        },
      });

      const attachedPty = pty;
      this.pty = attachedPty;
      this.ptyCols = message.cols;
      this.ptyRows = message.rows;
      attachedPty.onData((output) => this.handlePtyOutput(Buffer.from(output, "utf8")));
      attachedPty.onExit(({ exitCode, signal }) => {
        void this.handlePtyExit(attachedPty, exitCode, signal).catch((error) => this.handleAsyncFailure(error));
      });

      lease = await prepared.attach({
        ptyPid: attachedPty.pid,
        cols: message.cols,
        rows: message.rows,
        onEvent: (event) => this.send({ type: "viewport", version: terminalProtocolVersion, ...event }),
      });

      if (generation !== this.attachGeneration || this.disposed) {
        await releaseLease();
        return;
      }

      this.lease = lease;
      this.target = target;
      let shouldRedraw = this.parkedOutputOverflowed;
      let initialOutput: Buffer[] = [];
      if (this.socket) {
        this.state = "synchronizing";
        if (shouldRedraw) await lease.refresh();
        if (!shouldRedraw && this.parkedOutputOverflowed) {
          shouldRedraw = true;
          await lease.refresh();
        }
        initialOutput = this.takeParkedOutput();
        this.clearParkedOutput();
      }
      this.state = this.socket ? "attached" : "parked";
      this.registry.register(this);
      this.registered = true;

      if (this.socket) {
        this.sendReady(false, shouldRedraw ? "redraw" : "live");
        for (const chunk of initialOutput) this.sendBinary(chunk);
      } else {
        await this.returnViewportToDesktop();
        this.scheduleResumeExpiry();
      }
    } catch (error) {
      if (this.pty === pty) this.pty = undefined;
      if (pty) {
        try {
          await pty.kill();
        } catch {
          // The PTY may have exited while attach was failing.
        }
      }
      if (lease) await releaseLease();
      else await releasePrepared();
      this.lease = undefined;
      this.unregister();

      if (this.disposed || !this.socket) {
        this.state = "closed";
        this.disposed = true;
        return;
      }

      this.state = "awaiting_attach";
      this.sendError("attach_failed", error, true);
    }
  }

  private async handlePasteImage(message: Extract<ClientControlMessage, { type: "paste_image" }>): Promise<void> {
    if (!this.isAttached() || !this.lease) {
      this.sendError("not_attached", "Attach before pasting an image");
      return;
    }
    const bytes = Buffer.from(decodeBase64(message.data));
    if (bytes.length > maxPasteImageBytes) {
      this.sendError("paste_image_too_large", `Image exceeds the ${maxPasteImageBytes} byte paste limit`);
      return;
    }
    const imagePaster = this.options.imagePaster;
    if (!imagePaster) {
      this.sendError("paste_image_unavailable", "Image paste is not available on this host");
      return;
    }
    try {
      await this.claimMobileForInput(this.cols, this.rows);
      await imagePaster({
        paneId: this.lease.paneId,
        name: message.name,
        mimeType: message.mimeType,
        bytes,
      });
    } catch (error) {
      this.sendError("paste_image_failed", error);
    }
  }

  private sendReady(resumed: boolean, sync: "live" | "replay" | "redraw"): void {
    if (!this.target || !this.lease) return;
    this.send({
      type: "ready",
      version: terminalProtocolVersion,
      sessionId: this.sessionId,
      resumeToken: this.resumeToken,
      resumed,
      target: this.target,
      paneId: this.lease.paneId,
      windowId: this.lease.windowId,
      owner: this.lease.owner,
      sync,
      cols: this.cols,
      rows: this.rows,
    });
  }

  private send(message: ServerControlMessage): void {
    if (this.socket?.readyState !== muximodSocketReadyState.open) return;
    this.sendSocketData(encodeServerControlFrame(message));
  }

  private sendBinary(data: Buffer): void {
    if (this.socket?.readyState !== muximodSocketReadyState.open) return;
    this.sendSocketData(data);
  }

  private sendSocketData(data: string | Uint8Array): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== muximodSocketReadyState.open) return;
    try {
      const status = socket.send(data);
      // Bun reports 0 for a dropped frame and -1 when backpressure prevents
      // immediate delivery. Either case makes an ANSI delta incomplete, so
      // park the session and recover with a full redraw after resume.
      if (status === 0 || status === -1) this.handleTransportBackpressure(socket);
    } catch {
      this.handleTransportBackpressure(socket);
    }
  }

  private handleTransportBackpressure(socket: MuximodSocket): void {
    this.parkedOutputOverflowed = true;
    if (this.transportBackpressured) return;
    this.transportBackpressured = true;
    if (this.state === "attached") {
      this.state = "parked";
      void this.returnViewportToDesktop();
      this.scheduleResumeExpiry();
    }
    closeSocket(socket, 1013, "terminal output backpressure");
  }

  private async claimMobileForInput(cols: number, rows: number): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    const shouldResizePty = lease.owner !== "mobile" || this.ptyCols !== cols || this.ptyRows !== rows;
    await lease.claimMobile(cols, rows);
    if (!shouldResizePty) return;
    await this.pty?.resize(cols, rows);
    this.ptyCols = cols;
    this.ptyRows = rows;
  }

  private handlePtyOutput(data: Buffer): void {
    if (this.state === "attaching" || this.state === "parked" || this.state === "synchronizing") {
      const nextBytes = this.parkedOutputBytes + data.byteLength;
      if (nextBytes > TERMINAL_OUTPUT_GAP_MAX_BYTES) {
        this.parkedOutputOverflowed = true;
        this.parkedOutput = [];
        this.parkedOutputBytes = 0;
        return;
      }
      this.parkedOutput.push(data);
      this.parkedOutputBytes = nextBytes;
      return;
    }
    this.sendBinary(data);
  }

  private takeParkedOutput(): Buffer[] {
    const output = this.parkedOutput;
    this.parkedOutput = [];
    this.parkedOutputBytes = 0;
    return output;
  }

  private clearParkedOutput(): void {
    this.parkedOutput = [];
    this.parkedOutputBytes = 0;
    this.parkedOutputOverflowed = false;
  }

  private sendClosed(
    reason: "detached" | "terminal_exit" | "network_timeout" | "server_shutdown",
    code: number | null,
    signal: string | null,
  ): void {
    this.send({
      type: "closed",
      version: terminalProtocolVersion,
      sessionId: this.sessionId,
      reason,
      code,
      signal,
    });
  }

  private sendError(code: string, error: unknown, retryable = false): void {
    const message = error instanceof Error ? error.message : String(error);
    this.send({
      type: "error",
      version: terminalProtocolVersion,
      ...(this.registered ? { sessionId: this.sessionId } : {}),
      code,
      message,
      retryable,
    });
  }

  private async detachIntentionally(): Promise<void> {
    if (this.disposed) return;
    if (this.state !== "awaiting_attach") this.sendClosed("detached", null, null);
    await this.finalizeTransport(1000, "detached");
  }

  private async handleTransportClosed(): Promise<void> {
    if (this.disposed) return;
    this.detachSocketListeners();

    if (this.state === "awaiting_attach") {
      await this.finalizeTransport();
      return;
    }

    this.state = "parked";
    await this.returnViewportToDesktop();
    this.scheduleResumeExpiry();
  }

  private async returnViewportToDesktop(): Promise<void> {
    try {
      await this.lease?.returnToDesktop();
    } catch {
      // The lease expiry path still releases the viewport if tmux is
      // temporarily unavailable during transport loss.
    }
  }

  private scheduleResumeExpiry(): void {
    this.clearResumeTimer();
    if (this.resumeGraceMs === 0) {
      void this.finalizeTransport().catch((error) => this.handleAsyncFailure(error));
      return;
    }

    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (!this.disposed && (this.state === "parked" || this.state === "attaching")) {
        void this.finalizeTransport().catch((error) => this.handleAsyncFailure(error));
      }
    }, this.resumeGraceMs);
    this.resumeTimer.unref?.();
  }

  private clearResumeTimer(): void {
    if (!this.resumeTimer) return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }

  private async finalizeTransport(
    closeCode?: number,
    closeReason?: string,
    terminalExit?: { exitCode: number; signal: number | null },
  ): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = "closed";
    this.attachGeneration += 1;
    this.clearResumeTimer();
    this.clearParkedOutput();

    const socket = this.socket;
    await this.stopRuntime();
    this.unregister();
    if (terminalExit && socket) {
      this.sendClosed(
        "terminal_exit",
        terminalExit.exitCode,
        terminalExit.signal === null ? null : String(terminalExit.signal),
      );
    }
    this.detachSocketListeners();
    if (socket && closeCode !== undefined) closeSocket(socket, closeCode, closeReason ?? "closed");
  }

  private async stopRuntime(): Promise<void> {
    const pty = this.pty;
    this.pty = undefined;
    if (pty) {
      try {
        await pty.kill();
      } catch {
        // The PTY may already have exited.
      }
    }

    const lease = this.lease;
    this.lease = undefined;
    if (lease) {
      try {
        await lease.release();
      } catch {
        // The viewport may already have been released by a concurrent exit.
      }
    }
  }

  private async handlePtyExit(pty: PtyProcess, exitCode: number, signal: number | null): Promise<void> {
    if (this.pty !== pty) return;
    this.pty = undefined;
    if (this.disposed) return;
    await this.finalizeTransport(1000, "terminal_exit", { exitCode, signal });
  }

  private handleAsyncFailure(error: unknown): void {
    if (!this.disposed) this.sendError("terminal_operation_failed", error, true);
  }

  private unregister(): void {
    if (!this.registered) return;
    this.registry.unregister(this);
    this.registered = false;
  }

  private isAttached(): boolean {
    return this.state === "attached" && Boolean(this.pty && this.lease);
  }

  private isAttachedOrParked(): boolean {
    return (this.state === "attached" || this.state === "parked") && Boolean(this.pty && this.lease);
  }
}

function closeSocket(socket: MuximodSocket, code: number, reason: string): void {
  if (socket.readyState === muximodSocketReadyState.open || socket.readyState === muximodSocketReadyState.connecting) {
    try {
      socket.close(code, reason);
    } catch {
      // The transport may have completed its close handshake already.
    }
  }
}

function isViewportLeaseConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Viewport is already in use for tmux window:");
}

function opaqueId(): string {
  return `terminal-${randomBytes(12).toString("hex")}`;
}

function opaqueToken(): string {
  return randomBytes(32).toString("hex");
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function rawDataToBuffer(data: MuximodSocketData): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}
