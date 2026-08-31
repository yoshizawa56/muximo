export type TerminalData = string | Uint8Array;

export type TerminalOutputScheduler = {
  write: (data: TerminalData) => void;
  markScroll: () => void;
  dispose: () => void;
};

export type TerminalOutputSchedulerOptions = {
  write: (data: TerminalData) => void;
  /** Maximum buffered terminal output before the current screen is invalid. */
  maxPendingBytes?: number;
  /** Called after buffered output is discarded and an authoritative redraw is needed. */
  onOverflow?: () => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (handle: number) => void;
  normalIntervalMs?: number;
  scrollIdleMs?: number;
};

export type TerminalInputBatcher = {
  enqueue: (data: string) => void;
  flush: () => void;
  dispose: () => void;
};

export type TerminalInputBatcherOptions = {
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

export type TerminalInputQueue = {
  write: (data: string) => void;
  attach: (sendInput: (data: string) => void) => void;
  detach: (clearPending?: boolean) => void;
};

export type TerminalInputQueueOptions = {
  /** Allows a small amount of input before the first transport is ready. */
  queueBeforeAttach?: boolean;
  maxPendingBytes?: number;
};

const TERMINAL_OUTPUT_NORMAL_INTERVAL_MS = 32;
const TERMINAL_OUTPUT_SCROLL_IDLE_MS = 140;
const TERMINAL_OUTPUT_MAX_PENDING_BYTES = 512 * 1024;

export function createTerminalOutputScheduler(options: TerminalOutputSchedulerOptions): TerminalOutputScheduler {
  const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimeout = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
  const normalIntervalMs = Math.max(0, options.normalIntervalMs ?? TERMINAL_OUTPUT_NORMAL_INTERVAL_MS);
  const scrollIdleMs = Math.max(0, options.scrollIdleMs ?? TERMINAL_OUTPUT_SCROLL_IDLE_MS);
  const maxPendingBytes = Number.isFinite(options.maxPendingBytes)
    ? Math.max(1, Math.floor(options.maxPendingBytes ?? 0))
    : TERMINAL_OUTPUT_MAX_PENDING_BYTES;

  let pending: TerminalData[] = [];
  let pendingBytes = 0;
  let frame: number | null = null;
  let normalTimer: number | null = null;
  let scrollIdleTimer: number | null = null;
  let scrolling = false;
  let disposed = false;

  const clearFlushSchedule = () => {
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (normalTimer !== null) {
      clearTimeout(normalTimer);
      normalTimer = null;
    }
  };

  const flush = () => {
    frame = null;
    normalTimer = null;
    if (disposed) return;

    const batch = pending;
    pending = [];
    pendingBytes = 0;
    for (const data of batch) options.write(data);
    scheduleFlush();
  };

  const scheduleFlush = () => {
    if (disposed || pending.length === 0) return;
    if (scrolling) {
      if (frame === null) frame = requestFrame(flush);
      return;
    }
    if (normalTimer === null) normalTimer = scheduleTimeout(flush, normalIntervalMs);
  };

  const write = (data: TerminalData) => {
    if (disposed) return;
    const dataBytes = terminalDataByteLength(data);
    if (pendingBytes + dataBytes > maxPendingBytes) {
      pending = [];
      pendingBytes = 0;
      clearFlushSchedule();
      options.onOverflow?.();
      return;
    }
    pending.push(data);
    pendingBytes += dataBytes;
    scheduleFlush();
  };

  const markScroll = () => {
    if (disposed) return;
    scrolling = true;

    if (normalTimer !== null) {
      clearTimeout(normalTimer);
      normalTimer = null;
    }
    if (scrollIdleTimer !== null) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = scheduleTimeout(() => {
      scrollIdleTimer = null;
      scrolling = false;
      scheduleFlush();
    }, scrollIdleMs);
    scheduleFlush();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending = [];
    pendingBytes = 0;
    clearFlushSchedule();
    if (scrollIdleTimer !== null) {
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = null;
    }
  };

  return { write, markScroll, dispose };
}

export function createTerminalInputBatcher(
  sendInput: (data: string) => void,
  options: TerminalInputBatcherOptions = {},
): TerminalInputBatcher {
  const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  let pending = "";
  let frame: number | null = null;
  let disposed = false;

  const flushScheduled = () => {
    frame = null;
    if (disposed) return;
    const data = pending;
    pending = "";
    if (data) sendInput(data);
    if (pending && frame === null) frame = requestFrame(flushScheduled);
  };

  const flush = () => {
    if (disposed) return;
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    const data = pending;
    pending = "";
    if (data) sendInput(data);
  };

  const enqueue = (data: string) => {
    if (disposed || !data) return;
    pending += data;
    if (frame === null) frame = requestFrame(flushScheduled);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pending = "";
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
  };

  return { enqueue, flush, dispose };
}

const TERMINAL_INPUT_QUEUE_MAX_PENDING_BYTES = 4_096;

function terminalDataByteLength(data: TerminalData): number {
  return typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength;
}

export function createTerminalInputQueue(options: TerminalInputQueueOptions = {}): TerminalInputQueue {
  let pending = [] as string[];
  let pendingBytes = 0;
  let sendInput: ((data: string) => void) | null = null;
  let hasAttached = false;
  const queueBeforeAttach = options.queueBeforeAttach ?? true;
  const maxPendingBytes = Number.isFinite(options.maxPendingBytes)
    ? Math.max(0, Math.floor(options.maxPendingBytes ?? 0))
    : TERMINAL_INPUT_QUEUE_MAX_PENDING_BYTES;

  const write = (data: string) => {
    if (!data) return;
    if (sendInput) sendInput(data);
    else if (!hasAttached && queueBeforeAttach) {
      const dataBytes = new TextEncoder().encode(data).byteLength;
      if (pendingBytes + dataBytes > maxPendingBytes) return;
      pending.push(data);
      pendingBytes += dataBytes;
    }
  };

  const attach = (nextSendInput: (data: string) => void) => {
    sendInput = nextSendInput;
    hasAttached = true;
    const queued = pending;
    pending = [];
    pendingBytes = 0;
    for (const data of queued) sendInput(data);
  };

  const detach = (clearPending = false) => {
    sendInput = null;
    // Once a transport has been attached, never replay input over a later
    // connection. The shell state may have advanced while the socket was
    // unavailable; only the initial pre-ready queue is safe to retain.
    if (clearPending || hasAttached) {
      pending = [];
      pendingBytes = 0;
    }
  };

  return { write, attach, detach };
}
