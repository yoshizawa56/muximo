import type {
  TerminalHostHookEvent as ApplicationHookEvent,
  MuximodApplication,
  MuximodAuth,
  MuximodAuthContext,
} from "@muximo/application";
import type { MuximodEvent } from "@muximo/contract/api";
import type { MuximodSocket, MuximodSocketFactory } from "@muximo/infrastructure/runtime";

export type { MuximodAuth, MuximodAuthContext, MuximodAuthDevice } from "@muximo/application";

export type MuximodHookEvent = ApplicationHookEvent;

export type MuximodHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 426 | 429 | 500 | 503;

export type MuximodHttpLogger = {
  debug(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

/** Exact browser-origin policy injected by the muximod composition root. */
export type MuximodOriginPolicy = {
  allows(origin: string | null): boolean;
};

export type MuximodHttpDependencies = {
  auth: MuximodAuth;
  application: MuximodApplication;
  isReady?: () => boolean;
  configurationFingerprint: string;
  originPolicy: MuximodOriginPolicy;
  hookToken: string;
  /** Host-specific adapter construction is supplied by the composition root. */
  socketFactory: MuximodSocketFactory;
  onTerminalConnection?: (socket: MuximodSocket, context: MuximodAuthContext) => void;
  subscribeEvents?: (signal: AbortSignal) => AsyncIteratorObject<MuximodEvent>;
  logger?: MuximodHttpLogger;
};
