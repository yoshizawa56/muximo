import type {
  MuximodApplication,
  MuximodAuthContext,
  MuximodAuthDevice,
  MuximodAuthPort,
  MuximodHookEvent as ApplicationHookEvent,
  MuximodSocket,
} from "@muximo/application";
import type { MuximodEvent } from "@muximo/contract";

export type { MuximodAuthContext, MuximodAuthDevice, MuximodAuthPort } from "@muximo/application";

export type MuximodHookEvent = ApplicationHookEvent;

export type MuximodHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 426 | 429 | 500 | 503;

export type MuximodHttpLogger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

export type MuximodHttpDependencies = {
  auth: MuximodAuthPort;
  application: MuximodApplication;
  isReady?: () => boolean;
  corsOrigin: string;
  hookToken: string;
  onTerminalConnection?: (socket: MuximodSocket, context: MuximodAuthContext) => void;
  subscribeEvents?: (signal: AbortSignal) => AsyncIteratorObject<MuximodEvent>;
  logger?: MuximodHttpLogger;
};
