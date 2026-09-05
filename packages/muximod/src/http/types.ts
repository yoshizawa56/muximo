import type {
  TerminalHostHookEvent as ApplicationHookEvent,
  MuximodApplication,
  MuximodAuthContext,
  MuximodAuthPort,
} from "@muximo/application";
import type { MuximodEvent } from "@muximo/contract/api";
import type { AgentBackend } from "@muximo/domain";
import type { MuximodSocket, MuximodSocketFactory } from "@muximo/infrastructure/runtime";

export type { MuximodAuthContext, MuximodAuthDevice, MuximodAuthPort } from "@muximo/application";

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
  auth: MuximodAuthPort;
  application: MuximodApplication;
  isReady?: () => boolean;
  originPolicy: MuximodOriginPolicy;
  hookToken: string;
  /** Host-specific adapter construction is supplied by the composition root. */
  socketFactory: MuximodSocketFactory;
  onTerminalConnection?: (socket: MuximodSocket, context: MuximodAuthContext) => void;
  subscribeEvents?: (signal: AbortSignal) => AsyncIteratorObject<MuximodEvent>;
  logger?: MuximodHttpLogger;
  agentBackends?: {
    enabled: readonly AgentBackend[];
    default: AgentBackend | null;
  };
};
