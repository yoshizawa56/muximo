export const muximodSocketReadyState = {
  connecting: 0,
  open: 1,
  closing: 2,
  closed: 3,
} as const;

export type MuximodSocketData = string | Uint8Array;

/** Transport-neutral socket port used by terminal and event adapters. */
export interface MuximodSocket {
  readonly readyState: number;
  send(data: MuximodSocketData): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: MuximodSocketData, isBinary: boolean) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
}
