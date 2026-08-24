export type TerminalData = string | Uint8Array;

export type TerminalOutputScheduler = {
  write: (data: TerminalData) => void;
  markScroll: () => void;
  dispose: () => void;
};

export type TerminalOutputSchedulerOptions = {
  write: (data: TerminalData) => void;
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

const TERMINAL_OUTPUT_NORMAL_INTERVAL_MS = 32;
const TERMINAL_OUTPUT_SCROLL_IDLE_MS = 140;

export function createTerminalOutputScheduler(options: TerminalOutputSchedulerOptions): TerminalOutputScheduler {
  const requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimeout = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
  const normalIntervalMs = Math.max(0, options.normalIntervalMs ?? TERMINAL_OUTPUT_NORMAL_INTERVAL_MS);
  const scrollIdleMs = Math.max(0, options.scrollIdleMs ?? TERMINAL_OUTPUT_SCROLL_IDLE_MS);

  let pending: TerminalData[] = [];
  let frame: number | null = null;
  let normalTimer: number | null = null;
  let scrollIdleTimer: number | null = null;
  let scrolling = false;
  let disposed = false;

  const flush = () => {
    frame = null;
    normalTimer = null;
    if (disposed) return;

    const batch = pending;
    pending = [];
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
    pending.push(data);
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
    if (frame !== null) {
      cancelFrame(frame);
      frame = null;
    }
    if (normalTimer !== null) {
      clearTimeout(normalTimer);
      normalTimer = null;
    }
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
