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
import { openMuximodTerminal } from "../../../../../../../../app/api/muximod-client";
import type { MuximodConnection } from "../../../../../../../../app/api/muximod-client.js";
import { isMockMode, mockTerminalOutputForTarget } from "../../../../../../../../mock/mock-data";
import { muximoBridge } from "../../../../../../../../platform/muximo-bridge";
import { TERMINAL_FONT_FAMILY, waitForTerminalFont } from "./font";
import {
  createTerminalInputBatcher,
  createTerminalInputQueue,
  createTerminalOutputScheduler,
  type TerminalInputQueue,
} from "./scheduler";
import { installTerminalTouchInput, terminalMouseWheelInput } from "./touch";

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
  actionErrorMessage: string | null;
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
  keepNativeKeyboardOpen: () => void;
  toggleNativeKeyboard: () => void;
  nativeKeyboardVisible: boolean;
  pasteImage: (file: File) => void;
  enterCopyMode: () => void;
  pasteFromClipboard: () => Promise<void>;
  pasteFromTmuxBuffer: () => void;
};

export type NativeKeyboardToggleAction = "show" | "hide";

export function nativeKeyboardToggleAction(
  nativeKeyboardVisible: boolean,
  helperInputFocused: boolean,
): NativeKeyboardToggleAction {
  return nativeKeyboardVisible || helperInputFocused ? "hide" : "show";
}

export type TerminalControlErrorDisposition = "action" | "connection";

const terminalActionErrorCodes: ReadonlySet<string> = new Set([
  "not_attached",
  "mobile_claim_failed",
  "copy_mode_failed",
  "paste_tmux_buffer_failed",
  "resize_failed",
  "paste_image_too_large",
  "paste_image_unavailable",
  "paste_image_failed",
]);

export function terminalControlErrorDisposition(code: string, retryable: boolean): TerminalControlErrorDisposition {
  return !retryable && terminalActionErrorCodes.has(code) ? "action" : "connection";
}

function identityInputTransform(data: string): string {
  return data;
}

export function usePaneViewModel({
  target,
  connection,
  transformInput,
  suppressNativeTouch = false,
}: {
  target: string;
  connection?: MuximodConnection;
  transformInput?: (data: string) => string;
  suppressNativeTouch?: boolean;
}): PaneViewModel {
  const [terminalContainer, setTerminalContainer] = useState<HTMLDivElement | null>(null);
  const terminalContainerRef = useCallback<RefCallback<HTMLDivElement>>((node) => {
    setTerminalContainer(node);
  }, []);
  const [status, setStatus] = useState<PaneConnectionStatus>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionErrorMessage, setActionErrorMessage] = useState<string | null>(null);
  const [viewportOwner, setViewportOwner] = useState<PaneViewportOwner>("mobile");
  const [viewportReason, setViewportReason] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const terminalInputQueueRef = useRef<TerminalInputQueue>(createTerminalInputQueue());
  const socketInputQueueRef = useRef<TerminalInputQueue>(createTerminalInputQueue());
  const inputTransformRef = useRef(transformInput ?? identityInputTransform);
  const nativeKeyboardFocusPendingRef = useRef(false);
  const suppressNativeTouchRef = useRef(suppressNativeTouch);
  const connectRef = useRef<(() => void) | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const resumeRef = useRef<PaneResumeState | null>(null);
  const terminalClosedRef = useRef(false);
  const currentTargetRef = useRef(target);
  const pendingDetachRef = useRef<Promise<void> | null>(null);
  const [pasteState, setPasteState] = useState<PanePasteState>("idle");
  const [nativeKeyboardVisible, setNativeKeyboardVisible] = useState(false);
  const nativeKeyboardVisibleRef = useRef(false);
  const nativeKeyboardPreserveRef = useRef(false);
  const nativeKeyboardPreserveTimerRef = useRef<number | null>(null);
  const nativeKeyboardResettingRef = useRef(false);
  const keyboardViewportHeightRef = useRef<number | null>(null);
  const resetNativeKeyboardRef = useRef<(() => void) | null>(null);
  const pasteResetTimerRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    suppressNativeTouchRef.current = suppressNativeTouch;
  }, [suppressNativeTouch]);

  const sendInput = useCallback((data: string) => {
    terminalInputQueueRef.current.write(data);
  }, []);

  const focus = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      nativeKeyboardFocusPendingRef.current = true;
      return;
    }
    nativeKeyboardFocusPendingRef.current = false;
    const helperInput = terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperInput) helperInput.inputMode = "text";
    terminal.focus();
  }, []);

  const blur = useCallback(() => {
    nativeKeyboardPreserveRef.current = false;
    if (nativeKeyboardPreserveTimerRef.current !== null) {
      window.clearTimeout(nativeKeyboardPreserveTimerRef.current);
      nativeKeyboardPreserveTimerRef.current = null;
    }
    const terminal = terminalRef.current;
    if (!terminal) return;
    const helperInput = terminal.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (helperInput) {
      helperInput.inputMode = "none";
      helperInput.blur();
    }
  }, []);

  const keepNativeKeyboardOpen = useCallback(() => {
    const terminal = terminalRef.current;
    const helperInput = terminal?.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const shouldRestore = nativeKeyboardVisibleRef.current || helperInput === document.activeElement;
    if (!terminal || !helperInput || !shouldRestore) return;

    nativeKeyboardPreserveRef.current = true;
    if (nativeKeyboardPreserveTimerRef.current !== null) {
      window.clearTimeout(nativeKeyboardPreserveTimerRef.current);
    }
    nativeKeyboardPreserveTimerRef.current = window.setTimeout(() => {
      nativeKeyboardPreserveRef.current = false;
      nativeKeyboardPreserveTimerRef.current = null;
    }, 500);

    // The pointer handler prevents the button from taking focus. If the
    // platform still blurs the helper textarea, handleKeyboardBlur restores it
    // after the event. Refocusing during pointerdown can cancel a flick or
    // make WebKit restart the keyboard gesture.
  }, []);

  const toggleNativeKeyboard = useCallback(() => {
    nativeKeyboardPreserveRef.current = false;
    if (nativeKeyboardPreserveTimerRef.current !== null) {
      window.clearTimeout(nativeKeyboardPreserveTimerRef.current);
      nativeKeyboardPreserveTimerRef.current = null;
    }
    const terminal = terminalRef.current;
    const helperInput = terminal?.element?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const helperInputFocused = helperInput !== null && document.activeElement === helperInput;
    if (nativeKeyboardToggleAction(nativeKeyboardVisible, helperInputFocused) === "hide") {
      blur();
      return;
    }
    focus();
  }, [blur, focus, nativeKeyboardVisible]);

  useLayoutEffect(() => {
    currentTargetRef.current = target;
  }, [target]);

  useLayoutEffect(() => {
    inputTransformRef.current = transformInput ?? identityInputTransform;
  }, [transformInput]);

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

  const clearActionError = useCallback(() => {
    setActionErrorMessage(null);
  }, []);

  const reportActionError = useCallback((message: string) => {
    setActionErrorMessage(message);
  }, []);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    terminalClosedRef.current = false;
    resetNativeKeyboardRef.current?.();
    clearRetryTimer();
    clearActionError();
    setStatus("connecting");
    setErrorMessage(null);
    connectRef.current?.();
  }, [clearActionError, clearRetryTimer]);

  const claim = useCallback(() => {
    sendControl(socketRef.current, { type: "claim", version: terminalProtocolVersion });
  }, []);

  const enterCopyMode = useCallback(() => {
    clearActionError();
    if (sendControl(socketRef.current, { type: "enter_copy_mode", version: terminalProtocolVersion })) {
      focus();
      return;
    }
    reportActionError("Terminal is not connected");
  }, [clearActionError, focus, reportActionError]);

  const pasteFromTmuxBuffer = useCallback(() => {
    clearActionError();
    if (sendControl(socketRef.current, { type: "paste_tmux_buffer", version: terminalProtocolVersion })) return;
    reportActionError("Terminal is not connected");
  }, [clearActionError, reportActionError]);

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    clearActionError();
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
      reportActionError("Clipboard paste is unavailable in this browser");
      return;
    }
    try {
      const data = await navigator.clipboard.readText();
      if (!data) return;
      const terminal = terminalRef.current;
      if (!terminal || terminalClosedRef.current) {
        reportActionError("Terminal is not connected");
        return;
      }
      terminal.paste(data);
    } catch {
      reportActionError("Clipboard access was denied or failed");
    }
  }, [clearActionError, reportActionError]);

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
    const visualViewport = window.visualViewport;
    const setNativeKeyboardVisibility = (visible: boolean) => {
      nativeKeyboardVisibleRef.current = visible;
      setNativeKeyboardVisible(visible);
    };
    const syncNativeKeyboardVisibility = () => {
      if (!helperInput || document.activeElement !== helperInput) {
        keyboardViewportHeightRef.current = null;
        setNativeKeyboardVisibility(false);
        return;
      }
      const currentHeight = visualViewport?.height ?? window.innerHeight;
      const previousHeight = keyboardViewportHeightRef.current;
      const baselineHeight = previousHeight === null ? currentHeight : Math.max(previousHeight, currentHeight);
      keyboardViewportHeightRef.current = baselineHeight;
      setNativeKeyboardVisibility(baselineHeight - currentHeight > 80);
    };
    const handleKeyboardFocus = () => {
      if (!helperInput) return;
      const currentHeight = visualViewport?.height ?? window.innerHeight;
      keyboardViewportHeightRef.current = Math.max(keyboardViewportHeightRef.current ?? currentHeight, currentHeight);
      setNativeKeyboardVisibility(true);
    };
    const isKeyboardPreservingTarget = (target: EventTarget | null) =>
      target instanceof Element && target.closest('[data-preserve-native-keyboard-focus="true"]') !== null;
    const handleKeyboardBlur = (event: FocusEvent) => {
      const preserveFocus =
        nativeKeyboardPreserveRef.current ||
        isKeyboardPreservingTarget(event.relatedTarget) ||
        isKeyboardPreservingTarget(document.activeElement);
      if (!nativeKeyboardResettingRef.current && preserveFocus) {
        nativeKeyboardPreserveRef.current = false;
        if (nativeKeyboardPreserveTimerRef.current !== null) {
          window.clearTimeout(nativeKeyboardPreserveTimerRef.current);
          nativeKeyboardPreserveTimerRef.current = null;
        }
        setNativeKeyboardVisibility(true);
        helperInput?.focus({ preventScroll: true });
        window.requestAnimationFrame(() => {
          if (!nativeKeyboardResettingRef.current && document.activeElement !== helperInput) {
            helperInput?.focus({ preventScroll: true });
          }
        });
        return;
      }
      keyboardViewportHeightRef.current = null;
      setNativeKeyboardVisibility(false);
    };
    const resetNativeKeyboard = () => {
      nativeKeyboardPreserveRef.current = false;
      if (nativeKeyboardPreserveTimerRef.current !== null) {
        window.clearTimeout(nativeKeyboardPreserveTimerRef.current);
        nativeKeyboardPreserveTimerRef.current = null;
      }
      nativeKeyboardResettingRef.current = true;
      if (helperInput) {
        helperInput.inputMode = "none";
        helperInput.blur();
      }
      keyboardViewportHeightRef.current = null;
      setNativeKeyboardVisibility(false);
      nativeKeyboardResettingRef.current = false;
    };
    resetNativeKeyboardRef.current = resetNativeKeyboard;
    resetNativeKeyboard();
    helperInput?.addEventListener("focus", handleKeyboardFocus);
    helperInput?.addEventListener("blur", handleKeyboardBlur);
    visualViewport?.addEventListener("resize", syncNativeKeyboardVisibility);
    window.addEventListener("resize", syncNativeKeyboardVisibility);
    syncNativeKeyboardVisibility();
    fitAddon.fit();
    const terminalOutputScheduler = createTerminalOutputScheduler({
      write: (data) => terminal.write(data),
    });
    let disposed = false;
    if (nativeKeyboardFocusPendingRef.current) {
      nativeKeyboardFocusPendingRef.current = false;
      window.requestAnimationFrame(() => {
        if (!disposed && terminalRef.current === terminal) focus();
      });
    }

    const endpoint = connection ? connection.websocketUrl : "mock";
    const resumeKey = terminalResumeKey(endpoint, target);
    resumeRef.current = terminalResumeStore.read(resumeKey, target);
    terminalClosedRef.current = false;
    setStatus("connecting");
    setErrorMessage(null);
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
        socketInputQueueRef.current.detach();
        closeNetworkSocket(previousSocket);
      }

      let socket: WebSocket;
      try {
        socket = await openMuximodTerminal(connection);
      } catch {
        if (!disposed && !terminalClosedRef.current) {
          clearActionError();
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
              socketInputQueueRef.current.attach((data) => {
                if (socketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return;
                socket.send(new TextEncoder().encode(data));
              });
              retryCountRef.current = 0;
              terminalClosedRef.current = false;
              setStatus("connected");
              setErrorMessage(null);
              clearActionError();
              const nextResume = resumeStateFromReady(message, target);
              resumeRef.current = nextResume;
              terminalResumeStore.write(resumeKey, nextResume);
            },
            onClosed: (message) => {
              socketInputQueueRef.current.detach(true);
              resetNativeKeyboard();
              terminalClosedRef.current = true;
              terminalResumeStore.clear(resumeKey);
              resumeRef.current = null;
              setStatus("closed");
              setErrorMessage(message.reason === "detached" ? "Terminal detached" : "Terminal session closed");
              clearActionError();
            },
            onError: ({ code, message, retryable }) => {
              if (code === "resume_not_found" && resumeAttempt && !fallbackAttachSent) {
                fallbackAttachSent = true;
                resumeRef.current = null;
                terminalResumeStore.clear(resumeKey);
                socketInputQueueRef.current.detach();
                setStatus("connecting");
                sendAttach(socket);
                return;
              }

              if (terminalControlErrorDisposition(code, retryable) === "action") {
                reportActionError(message);
                return;
              }

              clearActionError();
              setStatus("error");
              setErrorMessage(message);
              resetNativeKeyboard();
              if (retryable) {
                socketInputQueueRef.current.detach();
                scheduleReconnect();
              }
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
        socketInputQueueRef.current.detach();
        resetNativeKeyboard();
        clearActionError();
        setStatus("error");
        setErrorMessage("WebSocket connection failed");
        scheduleReconnect();
      });

      socket.addEventListener("close", () => {
        if (!isCurrentSocket()) return;
        socketInputQueueRef.current.detach();
        resetNativeKeyboard();
        clearActionError();
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
      socketInputQueueRef.current.write(data);
    };
    const scrollInputBatcher = createTerminalInputBatcher(sendTerminalInput);
    const sendInteractiveTerminalInput = (data: string) => {
      scrollInputBatcher.flush();
      sendTerminalInput(data);
    };
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
    const touchOptions = {
      suppressNativeTouch: suppressNativeTouchRef.current,
      onGestureStart: () => {
        scrollRemainder = 0;
      },
      onScroll: scrollTerminal,
    };

    terminalInputQueueRef.current.attach(sendTerminalInput);

    if (isMockMode()) {
      setStatus("connected");
      setViewportReason("attached");
      terminal.write(mockTerminalOutputForTarget(target));

      const resizeObserver = new ResizeObserver(sendResize);
      resizeObserver.observe(container);
      window.addEventListener("resize", sendResize);
      sendResize();
      const touchCleanup = installTerminalTouchInput(container, touchOptions);
      const inputDisposable = terminal.onData(() => {
        // The mock is intentionally read-only.
      });

      return () => {
        disposed = true;
        connectRef.current = null;
        detachRef.current = null;
        resetNativeKeyboard();
        if (resetNativeKeyboardRef.current === resetNativeKeyboard) resetNativeKeyboardRef.current = null;
        clearRetryTimer();
        resizeObserver.disconnect();
        window.removeEventListener("resize", sendResize);
        window.removeEventListener("resize", syncNativeKeyboardVisibility);
        visualViewport?.removeEventListener("resize", syncNativeKeyboardVisibility);
        helperInput?.removeEventListener("focus", handleKeyboardFocus);
        helperInput?.removeEventListener("blur", handleKeyboardBlur);
        if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        touchCleanup();
        scrollInputBatcher.dispose();
        terminalOutputScheduler.dispose();
        inputDisposable.dispose();
        terminalInputQueueRef.current.detach(true);
        socketInputQueueRef.current.detach(true);
        nativeKeyboardFocusPendingRef.current = false;
        terminalRef.current = null;
        terminal.dispose();
      };
    }

    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(container);
    window.addEventListener("resize", sendResize);

    const inputDisposable = terminal.onData((data) => {
      sendInteractiveTerminalInput(inputTransformRef.current(data));
    });
    const binaryInputDisposable = terminal.onBinary((data) => {
      scrollInputBatcher.flush();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(binaryStringToBytes(data));
    });
    const touchCleanup = installTerminalTouchInput(container, touchOptions);
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
      resetNativeKeyboard();
      if (resetNativeKeyboardRef.current === resetNativeKeyboard) resetNativeKeyboardRef.current = null;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      clearRetryTimer();
      document.removeEventListener("visibilitychange", claimWhenVisible);
      window.removeEventListener("focus", claimWhenVisible);
      resizeObserver.disconnect();
      window.removeEventListener("resize", sendResize);
      window.removeEventListener("resize", syncNativeKeyboardVisibility);
      visualViewport?.removeEventListener("resize", syncNativeKeyboardVisibility);
      helperInput?.removeEventListener("focus", handleKeyboardFocus);
      helperInput?.removeEventListener("blur", handleKeyboardBlur);
      inputDisposable.dispose();
      binaryInputDisposable.dispose();
      touchCleanup();
      scrollInputBatcher.dispose();
      terminalOutputScheduler.dispose();
      resizeDisposable.dispose();
      const cleanupMode = terminalSessionCleanupMode(target, currentTargetRef.current);
      terminalInputQueueRef.current.detach(cleanupMode === "detach");
      socketInputQueueRef.current.detach(cleanupMode === "detach");
      nativeKeyboardFocusPendingRef.current = false;
      terminalRef.current = null;
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
  }, [claim, clearActionError, clearRetryTimer, connection, focus, reportActionError, target, terminalContainer]);

  return {
    target,
    status,
    errorMessage,
    actionErrorMessage,
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
    keepNativeKeyboardOpen,
    toggleNativeKeyboard,
    nativeKeyboardVisible,
    pasteImage,
    enterCopyMode,
    pasteFromClipboard,
    pasteFromTmuxBuffer,
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

function sendControl(socket: WebSocket | null, message: ClientControlMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(encodeClientControlFrame(message));
    return true;
  } catch {
    return false;
  }
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
