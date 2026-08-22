/** Terminal adapter contract for PTY processes; it remains outside application policy. */
export type PtyExit = {
  exitCode: number;
  signal: number | null;
};

export type PtySpawnOptions = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

export type PtyProcess = {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose: () => void };
  onExit(listener: (event: PtyExit) => void): { dispose: () => void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

/**
 * Bun-native PTY implementation used by both development and compiled builds.
 * Bun.Terminal owns the kernel PTY; Bun.spawn owns the child process lifecycle.
 */
export function spawnPty(file: string, args: string[], options: PtySpawnOptions): PtyProcess {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PtyExit) => void>();
  const decoder = new TextDecoder();
  let closed = false;

  const terminal = new Bun.Terminal({
    name: options.name,
    cols: options.cols,
    rows: options.rows,
    data: (_terminal, data) => {
      const output = decoder.decode(data, { stream: true });
      for (const listener of dataListeners) listener(output);
    },
  });

  const child = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal,
    onExit: (_process, exitCode, signalCode) => {
      if (closed) return;
      closed = true;
      const trailingOutput = decoder.decode();
      if (trailingOutput) {
        for (const listener of dataListeners) listener(trailingOutput);
      }
      terminal.close();
      const event = { exitCode: exitCode ?? 1, signal: signalCode } satisfies PtyExit;
      for (const listener of exitListeners) listener(event);
      dataListeners.clear();
      exitListeners.clear();
    },
  });

  return {
    pid: child.pid,
    onData(listener) {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write(data) {
      if (!closed) terminal.write(data);
    },
    resize(cols, rows) {
      if (!closed) terminal.resize(cols, rows);
    },
    kill() {
      if (closed) return;
      child.kill();
      terminal.close();
    },
  };
}
