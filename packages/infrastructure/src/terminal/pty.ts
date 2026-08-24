import type { PtyExit, PtyProcess, PtySpawnOptions } from "./contracts.js";

export type { PtyExit, PtyProcess, PtySpawner, PtySpawnOptions } from "./contracts.js";

/**
 * Bun-native PTY implementation used by both development and compiled builds.
 * Bun.Terminal owns the kernel PTY; Bun.spawn owns the child process lifecycle.
 */
export async function spawnPty(file: string, args: string[], options: PtySpawnOptions): Promise<PtyProcess> {
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
    async write(data) {
      if (!closed) terminal.write(data);
    },
    async resize(cols, rows) {
      if (!closed) terminal.resize(cols, rows);
    },
    async kill() {
      if (closed) return;
      child.kill();
      terminal.close();
    },
  };
}
