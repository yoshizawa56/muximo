import type {
  AgentSessionRepository,
  SessionAuditPort,
  SessionBaselineResult,
  SessionIdentityUpdate,
} from "@muximo/application";
import type { AgentBackend, AgentSession } from "@muximo/domain";
import type { Logger } from "../logging/index.js";
import { ClaudeBackendProvider } from "./claude/backend.js";
import { CodexBackendProvider } from "./codex/backend.js";
import type { CodexSessionStateRepository } from "./codex/state.js";
import type { AgentMonitor, AgentPluginRegistry } from "./index.js";
import { OpenCodeBackendProvider } from "./opencode/backend.js";

export type AgentBackendLaunch = {
  command: string[];
  monitor?: AgentMonitor;
  backendSessionId?: string | null;
  abortSession?: () => Promise<void>;
  dispose?: () => Promise<void>;
};

export type AgentBackendProviderPreparation = {
  sessionUpdate?: SessionIdentityUpdate;
  launch: AgentBackendLaunch;
};

export type AgentBackendProviderOptions = {
  environment: NodeJS.ProcessEnv;
  plugins: AgentPluginRegistry;
  sessions: AgentSessionRepository;
  audit: SessionAuditPort;
  logger: Pick<Logger, "debug" | "info" | "warn"> & {
    child(context: Record<string, unknown>): Pick<Logger, "debug" | "info" | "warn">;
  };
};

export interface AgentBackendProvider {
  readonly backend: AgentBackend;
  captureBaseline(session: AgentSession): Promise<SessionBaselineResult>;
  prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<AgentBackendProviderPreparation>;
  /** Reconstructs daemon-side observation for a process that survived a daemon restart. */
  restoreLaunch?(session: AgentSession): Promise<AgentBackendLaunch | undefined>;
  afterRun(session: AgentSession, runDir: string, startedAt: number): Promise<SessionIdentityUpdate | undefined>;
  disposeLaunch(session: AgentSession, runDir: string): Promise<void>;
  archive(session: AgentSession): Promise<boolean>;
  restore(session: AgentSession): Promise<boolean>;
  releaseIfUnused(session: AgentSession, remaining: readonly AgentSession[]): Promise<void>;
}

export class AgentBackendProviderRegistry {
  private readonly providers = new Map<AgentBackend, AgentBackendProvider>();

  public constructor(providers: readonly AgentBackendProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.backend))
        throw new Error(`agent backend provider already registered: ${provider.backend}`);
      this.providers.set(provider.backend, provider);
    }
  }

  public get(backend: AgentBackend): AgentBackendProvider {
    const provider = this.providers.get(backend);
    if (!provider) throw new Error(`agent backend provider is unavailable: ${backend}`);
    return provider;
  }
}

export function createDefaultAgentBackendProviders(
  options: AgentBackendProviderOptions,
  codexState: CodexSessionStateRepository,
  codexDefaultRemote: string,
): AgentBackendProviderRegistry {
  return new AgentBackendProviderRegistry([
    new CodexBackendProvider(options, codexState, codexDefaultRemote),
    new ClaudeBackendProvider(options),
    new OpenCodeBackendProvider(options),
  ]);
}
