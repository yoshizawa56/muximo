import type { TmuxPaneRef, TmuxWindowSnapshot } from "./tmux.js";

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
  /** Listener registration is synchronous so callback installation is atomic. */
  onData(listener: (data: string) => void): { dispose: () => void };
  onExit(listener: (event: PtyExit) => void): { dispose: () => void };
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
};

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => Promise<PtyProcess>;

export type TerminalProcessSpec = {
  file: string;
  args: string[];
};

export type ViewportOwner = "mobile" | "desktop";
export type ViewportReason =
  | "attached"
  | "mobile_claim"
  | "desktop_activity"
  | "desktop_resize"
  | "desktop_focus"
  | "detached";

export type ViewportEvent = {
  owner: ViewportOwner;
  reason: ViewportReason;
};

export type ViewportLease = {
  readonly id: string;
  readonly target: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly sessionName: string;
  claimMobile(cols?: number, rows?: number): Promise<void>;
  resize(cols?: number, rows?: number): Promise<void>;
  release(): Promise<void>;
};

export type PreparedViewport = {
  readonly target: string;
  readonly pane: TmuxPaneRef;
  /** Fully qualified pane target in the temporary mobile session group. */
  readonly attachTarget: string;
  readonly snapshot: TmuxWindowSnapshot;
  attach(options: AttachViewportOptions): Promise<ViewportLease>;
  release(): Promise<void>;
};

export type AttachViewportOptions = {
  ptyPid: number;
  cols: number;
  rows: number;
  onEvent(event: ViewportEvent): void;
};

export interface TerminalViewportPort {
  prepare(target: string, cwd: string, cols?: number, rows?: number): Promise<PreparedViewport>;
  buildAttachProcess(target: string): TerminalProcessSpec;
}

export type ImagePasteInput = {
  paneId: string;
  name: string;
  mimeType?: string;
  bytes: Buffer;
};

export type ImagePaster = (input: ImagePasteInput) => Promise<void>;
