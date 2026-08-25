import {
  type ClientControlMessage,
  decodeServerControlFrame,
  encodeClientControlFrame,
  type ServerControlMessage,
  terminalProtocolVersion,
} from "@muximo/contract";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type RefCallback, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openMuximodTerminal } from "../../../../../../../app/api/muximod-client";
import type { MuximodConnection } from "../../../../../../../app/api/muximod-client.js";
import { isMockMode, mockTerminalOutputForTarget } from "../../../../../../../mock/mock-data";
import { muximoBridge } from "../../../../../../../platform/muximo-bridge";
import {
  installTerminalFlickInput,
  type TerminalFlickPreview,
  type TerminalFlickRepeatConfig,
  terminalMouseWheelInput,
} from "./-terminal-flick";
import { TERMINAL_FONT_FAMILY, waitForTerminalFont } from "./-terminal-font";
import { createTerminalInputBatcher, createTerminalOutputScheduler } from "./-terminal-scheduler";

export type PaneConnectionStatus = "connecting" | "connected" | "closed" | "error";
export type PaneViewportOwner = "mobile" | "desktop";
export type PanePasteState = "idle" | "pasting" | "pasted" | "failed";

export type PaneResumeState = {
  sessionId: string;
  resumeToken: string;
  target: string;
};

export type TerminalResumeStore = {
  read: (key: string, target: string) => PaneResumeState | null;
  write: (key: string, state: PaneResumeState) => void;
  clear: (key: string) => void;
};

/**
 * Keeps resume credentials in this browser tab's JavaScript memory. SPA
 * remounts and network reconnects retain the credential, while a full
 * document reload starts a fresh attach instead of persisting it in storage.
 */
export function createTerminalResumeStore(): TerminalResumeStore {
  const states = new Map<string, PaneResumeState>();
  return {
    read: (key, target) => {
      const state = states.get(key);
      return state?.target === target ? state : null;
    },
    write: (key, state) => {
      states.set(key, state);
    },
    clear: (key) => {
      states.delete(key);
    },
  };
}

const terminalResumeStore = createTerminalResumeStore();

export type PaneViewModel = {
  target: string;
  status: PaneConnectionStatus;
  errorMessage: string | null;
  viewportOwner: PaneViewportOwner;
  viewportReason: string | null;
  pasteState: PanePasteState;
  terminalContainerRef: RefCallback<HTMLDivElement>;
  reconnect: () => void;
  claim: () => void;
  detach: () => void;
  sendInput: (data: string) => void;
  focus: () => void;
  blur: () => void;
  setFlickRepeat: (config: TerminalFlickRepeatConfig) => void;
  pasteImage: (file: File) => void;
};

export function usePaneViewModel({
  target,
  connection,
  onFlickPreviewChange,
}: {
  target: string;
  connection?: MuximodConnection;
  onFlickPreviewChange?: (preview: TerminalFlickPreview | null) => void;
}): PaneViewModel {
  const [terminalContainer, setTerminalContainer] = useState<HTMLDivElement | null>(null);
  const terminalContainerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setTerminalContainer(node);
  }, []);
  const [status, setStatus] = useState<PaneConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewportOwner, setViewportOwner] = useState<PaneViewportOwner>("mobile");
  const [viewportReason, setViewportReason] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => undefined);
  const flickRepeatRef = useRef<TerminalFlickRepeatConfig>({ startDelayMs: 420, intervalMs: 180 });
  const flickPreviewChangeRef = useRef(onFlickPreviewChange);
  const connectRef = useRef<(() => void) | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const resumeRef = useRef<PaneResumeState | null>(null);
  const terminalClosedRef = useRef(false);
  const currentTargetRef = useRef(target);
  const pendingDetachRef = useRef<Promise<void> | null>(null);
  const [pasteState, setPasteState] = useState<PanePasteState>("idle");
  const pasteResetTimerRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    flickPreviewChangeRef.current = onFlickPreviewChange;
  }, [onFlickPreviewChange]);

  const sendInput = useCallback((data: string) => {
    sendInputRef.current(data);
  }, []);

  const focus = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const helperInput = terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperInput) helperInput.inputMode = "text";
    terminal.focus();
  }, []);

  const blur = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const helperInput = terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperInput) {
      helperInput.inputMode = "none";
      helperInput.blur();
    }
  }, []);

  const setFlickRepeat = useCallback((config: TerminalFlickRepeatConfig) => {
    flickRepeatRef.current = {
      startDelayMs: Math.max(0, config.startDelayMs),
      intervalMs: Math.max(16, config.intervalMs),
    };
  }, []);
  useLayoutEffect(() => {
    currentTargetRef.current = target;
  }, [target]);

  useEffect(
    () => () => {
      if (pasteResetTimerRef.current !== null) window.clearTimeout(pasteResetTimerRef.current);
    },
    [],
  );

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    terminalClosedRef.current = false;
    clearRetryTimer();
    setStatus("connecting");
    setErrorMessage(null);
    connectRef.current?.();
  }, [clearRetryTimer]);

  const claim = useCallback(() => {
    sendControl(socketRef.current, { type: "claim", version: terminalProtocolVersion });
  }, []);

  const detach = useCallback(() => {
    terminalClosedRef.current = true;
    clearRetryTimer();
    detachRef.current?.();
  }, [clearRetryTimer]);

  const schedulePasteReset = useCallback(() => {
    if (pasteResetTimerRef.current !== null) window.clearTimeout(pasteResetTimerRef.current);
    pasteResetTimerRef.current = window.setTimeout(() => {
      pasteResetTimerRef.current = null;
      setPasteState("idle");
    }, PASTE_NOTICE_DURATION_MS);
  }, []);

  const pasteImage = useCallback(
    (file: File) => {
      void (async () => {
        if (isMockMode()) {
          setPasteState("pasted");
          schedulePasteReset();
          return;
        }
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          setPasteState("failed");
          schedulePasteReset();
          return;
        }
        try {
          setPasteState("pasting");
          const data = await fileToBase64(file);
          sendControl(
            socket,
            createPasteImageMessage({
              name: file.name || "image",
              mimeType: file.type || undefined,
              data,
            }),
          );
          setPasteState("pasted");
        } catch {
          setPasteState("failed");
        }
        schedulePasteReset();
      })();
    },
    [schedulePasteReset],
  );

  useEffect(
    () =>
      muximoBridge.onAppStateChange((state) => {
        if (state === "active" && !terminalClosedRef.current) reconnect();
      }),
    [reconnect],
  );

  useEffect(() => {
    // The terminal surface is mounted by the control-room route. The hook lives
    // above that route, so the DOM ref is the reliable lifecycle signal here;
    // gating on the route stage can race with the ref callback during SPA
    // navigation and leave the surface permanently uninitialized.
    if (!target || !terminalContainer || (!connection && !isMockMode())) return;

    const container = terminalContainer;
    const fontSize = terminalFontSize();
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize,
      lineHeight: 1.05,
      letterSpacing: 0,
      scrollback: 0,
      theme: {
        background: "#111318",
        foreground: "#f2f4f8",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    const helperInput = terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperInput) helperInput.inputMode = "none";
    fitAddon.fit();
    const terminalOutputScheduler = createTerminalOutputScheduler({
      write: (data) => terminal.write(data),
    });

    const endpoint = connection ? connection.websocketUrl : "mock";
    const resumeKey = terminalResumeKey(endpoint, target);
    resumeRef.current = terminalResumeStore.read(resumeKey, target);
    terminalClosedRef.current = false;
    setStatus("connecting");
    setErrorMessage(null);
    let disposed = false;
    let resizeFrame: number | null = null;
    let retryScheduled = false;
    let socketGeneration = 0;

    void waitForTerminalFont(fontSize).then(() => {
      if (disposed) return;
      terminal.refresh(0, terminal.rows - 1);
      fitAddon.fit();
    });

    const scheduleReconnect = () => {
      if (disposed || terminalClosedRef.current || retryScheduled || retryCountRef.current >= 8) return;
      retryScheduled = true;
      const attempt = retryCountRef.current++;
      const delay = Math.min(1_000 * 2 ** attempt, 10_000);
      setStatus("connecting");
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        retryScheduled = false;
        if (!disposed) connect();
      }, delay);
    };

    const sendResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (disposed) return;

        fitAddon.fit();
        sendControl(socketRef.current, {
          type: "resize",
          version: terminalProtocolVersion,
          cols: terminal.cols,
          rows: terminal.rows,
        });
      });
    };

    const sendAttach = (socket: WebSocket) => {
      const resume = resumeRef.current?.target === target ? resumeRef.current : null;
      const message = createTerminalAttachMessage({
        target,
        cols: terminal.cols,
        rows: terminal.rows,
        resume,
      });
      socket.send(encodeClientControlFrame(message));
    };

    const connect = async () => {
      if (disposed || terminalClosedRef.current) return;

      const pendingDetach = pendingDetachRef.current;
      if (pendingDetach) {
        pendingDetachRef.current = null;
        await pendingDetach;
        if (disposed || terminalClosedRef.current) return;
      }

      if (!connection) return;

      const previousSocket = socketRef.current;
      if (
        previousSocket &&
        (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING)
      ) {
        socketRef.current = null;
        closeNetworkSocket(previousSocket);
      }

      let socket: WebSocket;
      try {
        socket = await openMuximodTerminal(connection);
      } catch {
        if (!disposed && !terminalClosedRef.current) {
          setStatus("error");
          setErrorMessage("muximod authentication failed");
          scheduleReconnect();
        }
        return;
      }
      if (disposed || terminalClosedRef.current) {
        closeNetworkSocket(socket);
        return;
      }
      const generation = ++socketGeneration;
      const isCurrentSocket = () => !disposed && socketRef.current === socket && generation === socketGeneration;
      const resumeAttempt = Boolean(resumeRef.current?.target === target);
      let fallbackAttachSent = false;

      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      setStatus("connecting");
      setErrorMessage(null);

      socket.addEventListener("open", () => {
        if (!isCurrentSocket()) return;
        fitAddon.fit();
        sendAttach(socket);
      });

      socket.addEventListener("message", (event) => {
        if (!isCurrentSocket()) return;
        if (typeof event.data === "string") {
          handleControlMessage(event.data, {
            onReady: (message) => {
              retryCountRef.current = 0;
              terminalClosedRef.current = false;
              setStatus("connected");
              setErrorMessage(null);
              const nextResume = resumeStateFromReady(message, target);
              resumeRef.current = nextResume;
              terminalResumeStore.write(resumeKey, nextResume);
            },
            onClosed: (message) => {
              terminalClosedRef.current = true;
              terminalResumeStore.clear(resumeKey);
              resumeRef.current = null;
              setStatus("closed");
              setErrorMessage(message.reason === "detached" ? "Terminal detached" : "Terminal session closed");
            },
            onError: ({ code, message, retryable }) => {
              if (code === "resume_not_found" && resumeAttempt && !fallbackAttachSent) {
                fallbackAttachSent = true;
                resumeRef.current = null;
                terminalResumeStore.clear(resumeKey);
                setStatus("connecting");
                sendAttach(socket);
                return;
              }

              setStatus("error");
              setErrorMessage(message);
              if (retryable) scheduleReconnect();
            },
            onViewport: (owner, reason) => {
              setViewportOwner(owner);
              setViewportReason(reason);
            },
          });
          return;
        }

        terminalOutputScheduler.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data);
      });

      socket.addEventListener("error", () => {
        if (!isCurrentSocket() || terminalClosedRef.current) return;
        setStatus("error");
        setErrorMessage("WebSocket connection failed");
        scheduleReconnect();
      });

      socket.addEventListener("close", () => {
        if (!isCurrentSocket()) return;
        socketRef.current = null;
        if (terminalClosedRef.current) return;
        setStatus("connecting");
        scheduleReconnect();
      });
    };

    connectRef.current = () => {
      void connect();
    };
    detachRef.current = () => {
      const socket = socketRef.current;
      resumeRef.current = null;
      terminalResumeStore.clear(resumeKey);
      if (socket?.readyState === WebSocket.OPEN) {
        sendControl(socket, {
          type: "detach",
          version: terminalProtocolVersion,
        });
      } else if (socket?.readyState === WebSocket.CONNECTING) {
        closeNetworkSocket(socket, "detached");
      }
      setStatus("closed");
    };

    let scrollRemainder = 0;
    const sendTerminalInput = (data: string) => {
      if (isMockMode()) return;
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    };
    const scrollInputBatcher = createTerminalInputBatcher(sendTerminalInput);
    const sendInteractiveTerminalInput = (data: string) => {
      scrollInputBatcher.flush();
      sendTerminalInput(data);
    };
    sendInputRef.current = sendInteractiveTerminalInput;
    const scrollTerminal = (deltaY: number, clientX: number, clientY: number) => {
      terminalOutputScheduler.markScroll();
      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen") ?? terminal.element ?? container;
      const rect = screen.getBoundingClientRect();
      const cellWidth = terminal.cols > 0 && rect.width > 0 ? rect.width / terminal.cols : 0;
      const cellHeight = terminal.rows > 0 && rect.height > 0 ? rect.height / terminal.rows : 0;
      if (!cellWidth || !cellHeight) return;

      scrollRemainder += -deltaY / cellHeight;
      const lineDelta = scrollRemainder > 0 ? Math.floor(scrollRemainder) : Math.ceil(scrollRemainder);
      if (!lineDelta) return;
      scrollRemainder -= lineDelta;
      const column = Math.min(terminal.cols, Math.max(1, Math.floor((clientX - rect.left) / cellWidth) + 1));
      const row = Math.min(terminal.rows, Math.max(1, Math.floor((clientY - rect.top) / cellHeight) + 1));
      const direction = lineDelta > 0 ? "down" : "up";
      const wheelInput = Array.from({ length: Math.abs(lineDelta) }, () =>
        terminalMouseWheelInput(direction, column, row),
      ).join("");
      scrollInputBatcher.enqueue(wheelInput);
    };
    const flickOptions = {
      onGestureStart: () => {
        scrollRemainder = 0;
      },
      onScroll: scrollTerminal,
      getRepeatConfig: () => flickRepeatRef.current,
      onPreviewChange: (preview: TerminalFlickPreview | null) => flickPreviewChangeRef.current?.(preview),
    };

    if (isMockMode()) {
      setStatus("connected");
      setViewportReason("attached");
      terminal.write(mockTerminalOutputForTarget(target));

      const resizeObserver = new ResizeObserver(sendResize);
      resizeObserver.observe(container);
      window.addEventListener("resize", sendResize);
      sendResize();
      const flickCleanup = installTerminalFlickInput(
        container,
        () => {
          // The mock is intentionally read-only. Real input is wired to muximod below.
        },
        flickOptions,
      );
      const inputDisposable = terminal.onData(() => {
        // The mock is intentionally read-only.
      });

      return () => {
        disposed = true;
        connectRef.current = null;
        detachRef.current = null;
        clearRetryTimer();
        resizeObserver.disconnect();
        window.removeEventListener("resize", sendResize);
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        flickCleanup();
        scrollInputBatcher.dispose();
        terminalOutputScheduler.dispose();
        inputDisposable.dispose();
        sendInputRef.current = () => undefined;
        terminalRef.current = null;
        terminal.dispose();
      };
    }

    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", sendResize);

    const inputDisposable = terminal.onData((data) => {
      sendInteractiveTerminalInput(data);
    });
    const binaryInputDisposable = terminal.onBinary((data) => {
      scrollInputBatcher.flush();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(binaryStringToBytes(data));
    });
    const flickCleanup = installTerminalFlickInput(
      container,
      (data) => {
        sendInteractiveTerminalInput(data);
      },
      flickOptions,
    );
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      sendControl(socketRef.current, { type: "resize", version: terminalProtocolVersion, cols, rows });
    });

    const claimWhenVisible = () => {
      if (document.visibilityState === "visible") claim();
    };
    document.addEventListener("visibilitychange", claimWhenVisible);
    window.addEventListener("focus", claimWhenVisible);
    sendResize();
    void connect();

    return () => {
      disposed = true;
      connectRef.current = null;
      detachRef.current = null;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      clearRetryTimer();
      document.removeEventListener("visibilitychange", claimWhenVisible);
      window.removeEventListener("focus", claimWhenVisible);
      resizeObserver.disconnect();
      window.removeEventListener("resize", sendResize);
      inputDisposable.dispose();
      binaryInputDisposable.dispose();
      flickCleanup();
      scrollInputBatcher.dispose();
      terminalOutputScheduler.dispose();
      resizeDisposable.dispose();
      sendInputRef.current = () => undefined;
      terminalRef.current = null;
      const cleanupMode = terminalSessionCleanupMode(target, currentTargetRef.current);
      if (cleanupMode === "detach") {
        terminalClosedRef.current = true;
        resumeRef.current = null;
        terminalResumeStore.clear(resumeKey);
      }
      const socket = socketRef.current;
      socketRef.current = null;
      if (cleanupMode === "detach") {
        if (socket) pendingDetachRef.current = detachSocketAndWait(socket);
      } else if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        // Effect cleanup is a transport loss when the same pane is remounted.
        // This lets a remounted pane resume the same PTY during the grace window.
        closeNetworkSocket(socket);
      }
      terminal.dispose();
    };
  }, [claim, clearRetryTimer, connection, target, terminalContainer]);

  return {
    target,
    status,
    errorMessage,
    viewportOwner,
    viewportReason,
    pasteState,
    terminalContainerRef,
    reconnect,
    claim,
    detach,
    sendInput,
    focus,
    blur,
    setFlickRepeat,
    pasteImage,
  };
}

export function createPasteImageMessage({
  name,
  mimeType,
  data,
}: {
  name: string;
  mimeType?: string;
  data: string;
}): Extract<ClientControlMessage, { type: "paste_image" }> {
  return {
    type: "paste_image",
    version: terminalProtocolVersion,
    name,
    ...(mimeType ? { mimeType } : {}),
    data,
  };
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected image"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read the selected image"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function createTerminalAttachMessage({
  target,
  cols,
  rows,
  resume,
}: {
  target: string;
  cols: number;
  rows: number;
  resume?: PaneResumeState | null;
}): Extract<ClientControlMessage, { type: "attach" }> {
  return {
    type: "attach",
    version: terminalProtocolVersion,
    target,
    cols,
    rows,
    ...(resume && resume.target === target ? { sessionId: resume.sessionId, resumeToken: resume.resumeToken } : {}),
  };
}

export function resumeStateFromReady(
  message: Extract<ServerControlMessage, { type: "ready" }>,
  target: string,
): PaneResumeState {
  return {
    sessionId: message.sessionId,
    resumeToken: message.resumeToken,
    target,
  };
}

export type TerminalSessionCleanupMode = "preserve" | "detach";

export function terminalSessionCleanupMode(effectTarget: string, currentTarget: string): TerminalSessionCleanupMode {
  return effectTarget === currentTarget ? "preserve" : "detach";
}

export function handleControlMessage(
  rawMessage: string,
  handlers: {
    onReady: (message: Extract<ServerControlMessage, { type: "ready" }>) => void;
    onClosed: (message: Extract<ServerControlMessage, { type: "closed" }>) => void;
    onError: (message: { code: string; message: string; retryable: boolean }) => void;
    onViewport: (owner: PaneViewportOwner, reason: string) => void;
  },
): void {
  const decoded = decodeServerControlFrame(rawMessage);
  if (!decoded.ok) {
    handlers.onError({
      code: "invalid_control_frame",
      message: "Invalid control frame from muximod",
      retryable: false,
    });
    return;
  }

  const message = decoded.message;
  if (message.type === "ready") handlers.onReady(message);
  if (message.type === "closed") handlers.onClosed(message);
  if (message.type === "error")
    handlers.onError({ code: message.code, message: message.message, retryable: message.retryable ?? false });
  if (message.type === "viewport") handlers.onViewport(message.owner, message.reason);
}

function sendControl(socket: WebSocket | null, message: ClientControlMessage): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(encodeClientControlFrame(message));
}

function binaryStringToBytes(data: string): ArrayBuffer {
  const bytes = new Uint8Array(new ArrayBuffer(data.length));
  for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
  return bytes.buffer;
}

const TERMINAL_DETACH_TIMEOUT_MS = 2_000;
const PASTE_NOTICE_DURATION_MS = 3_000;

function detachSocketAndWait(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve) => {
    let timeout: number | null = null;
    const finish = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", finish);
      socket.removeEventListener("error", onError);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const decoded = decodeServerControlFrame(event.data);
      if (decoded.ok && decoded.message.type === "closed") finish();
    };
    const onError = () => closeNetworkSocket(socket, "detached");

    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", finish);
    socket.addEventListener("error", onError);
    timeout = window.setTimeout(() => {
      closeNetworkSocket(socket, "detached");
      finish();
    }, TERMINAL_DETACH_TIMEOUT_MS);

    try {
      if (socket.readyState === WebSocket.OPEN) {
        sendControl(socket, { type: "detach", version: terminalProtocolVersion });
      } else {
        closeNetworkSocket(socket, "detached");
      }
    } catch {
      closeNetworkSocket(socket, "detached");
      finish();
    }
  });
}

function closeNetworkSocket(socket: WebSocket, reason?: string): void {
  try {
    socket.close(1000, reason ?? "network-lost");
  } catch {
    // The browser may have completed the close handshake already.
  }
}

function terminalResumeKey(endpoint: string, target: string): string {
  return `muximo:terminal-resume:${endpoint}:${target}`;
}

function terminalFontSize(): number {
  if (typeof window !== "undefined" && window.innerWidth <= 620) return 11;
  if (typeof window !== "undefined" && window.innerWidth <= 920) return 12;
  return 12;
}
