import type { AgentBackend, AgentSession, Workspace, WorkspaceDirectoryOption, WorkspaceId } from "@muximo/domain";
import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type {
  AgentExecutionReceipt,
  AgentExecutionResult,
  AgentSessionListObservation,
  AgentStateObservation,
  CleanupResult,
  HookResult,
  LaunchPreparation,
  ManagedWorktreeState,
  ProcessLiveness,
  SessionBaselineResult,
  SessionIdentityUpdate,
  WorkspaceResolutionInput,
} from "../../ports/agent-sessions.js";
import type {
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
} from "../../ports/repositories.js";

export interface WorkspaceResolver {
  resolveCurrent(input?: WorkspaceResolutionInput): ApplicationEffect<Workspace>;
}

export interface SessionNaming {
  resolveName(
    workspaceId: WorkspaceId,
    requestedName: string | undefined,
    backend: AgentBackend,
  ): ApplicationEffect<string>;
}

export interface Hook {
  resolveHook(value: string, workspaceRoot: string): ApplicationEffect<string>;
  resolveStoredHook(path: string | undefined): ApplicationEffect<string | undefined>;
  run(session: AgentSession, kind: "setup" | "cleanup"): ApplicationEffect<HookResult>;
  removeOutputs(session: AgentSession): ApplicationEffect<void>;
}

export interface Worktree {
  create(workspace: WorkspaceDirectoryOption, name: string, override?: string): ApplicationEffect<ManagedWorktreeState>;
  copyFiles(target: Pick<AgentSession, "workspaceRoot" | "worktreePath">): ApplicationEffect<boolean>;
  isRegistered(session: AgentSession): ApplicationEffect<boolean>;
  hasChanges(session: AgentSession): ApplicationEffect<boolean>;
  remove(session: AgentSession, force: boolean): ApplicationEffect<CleanupResult>;
}

export interface SessionLauncher {
  captureBaseline(session: AgentSession): ApplicationEffect<SessionBaselineResult>;
  prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): ApplicationEffect<LaunchPreparation>;
  startLaunch(session: AgentSession): ApplicationEffect<void>;
  completeLaunch(
    session: AgentSession,
    process: AgentExecutionResult,
  ): ApplicationEffect<SessionIdentityUpdate | undefined>;
  disposeLaunch(session: AgentSession): ApplicationEffect<void>;
}

export interface RemoteSession {
  archive(session: AgentSession): ApplicationEffect<boolean>;
  restore(session: AgentSession): ApplicationEffect<boolean>;
}

export interface SessionResource {
  releaseIfUnused(session: AgentSession, remaining: readonly AgentSession[]): ApplicationEffect<void>;
}

export interface AgentObservation {
  observe(session: AgentSession, observation: AgentStateObservation): ApplicationEffect<void>;
}

export interface PanePublication {
  adopt(session: AgentSession, hostPaneId?: string): ApplicationEffect<void>;
  release(session: AgentSession, hostPaneId?: string): ApplicationEffect<void>;
  publish(
    session: AgentSession,
    state: "running" | "completed" | "failed" | "stopped",
    hostPaneId?: string,
  ): ApplicationEffect<void>;
}

export interface ProcessObservation {
  observe(pid: number, expectedStartedAt?: string): ApplicationEffect<ProcessLiveness>;
}

export interface SessionObservation {
  resolveWorkspace(): ApplicationEffect<Pick<Workspace, "id">>;
  observeSession(session: AgentSession, now: number): ApplicationEffect<AgentSessionListObservation>;
}

export interface SessionListClock {
  now(): number;
}

export interface SessionAudit {
  record(eventType: string, entityId: string, payload: unknown): ApplicationEffect<void>;
}

export interface SessionClock {
  now(): string;
  id(): string;
}

export interface ManagedAgentSessionRepository {
  findById(id: AgentSession["id"]): ApplicationEffect<AgentSession | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): ApplicationEffect<AgentSession | undefined>;
  list(workspaceId?: WorkspaceId): ApplicationEffect<AgentSession[]>;
  insert(record: AgentSession): ApplicationEffect<void>;
  update(record: AgentSession): ApplicationEffect<void>;
  claimExecution(input: ClaimExecutionInput): ApplicationEffect<boolean>;
  claimAbandonedExecution(input: ClaimAbandonedExecutionInput): ApplicationEffect<boolean>;
  attachExecution(input: AttachExecutionInput): ApplicationEffect<boolean>;
  delete(id: AgentSession["id"]): ApplicationEffect<void>;
  findExecutionReceipt(executionId: string): ApplicationEffect<AgentExecutionReceipt | undefined>;
  saveExecutionReceipt(receipt: AgentExecutionReceipt): ApplicationEffect<void>;
}

export interface SessionLogger {
  child(fields: Record<string, unknown>): SessionLogger;
  debug(event: string, fields?: Record<string, unknown>): void;
}

export interface SessionCleanupConfirmation {
  confirm(session: AgentSession, dirty: boolean): ApplicationEffect<boolean>;
}

/** Application-owned workspace resolution capability for agent sessions. */
export class WorkspaceResolverService extends Context.Service<WorkspaceResolverService, WorkspaceResolver>()(
  "@muximo/application/WorkspaceResolver",
) {}

/** Application-owned agent-session naming capability. */
export class SessionNamingService extends Context.Service<SessionNamingService, SessionNaming>()(
  "@muximo/application/SessionNaming",
) {}

/** Application-owned workspace hook capability for agent sessions. */
export class HookService extends Context.Service<HookService, Hook>()("@muximo/application/Hook") {}

/** Application-owned Git worktree capability for agent sessions. */
export class WorktreeService extends Context.Service<WorktreeService, Worktree>()("@muximo/application/Worktree") {}

/** Application-owned provider launch capability. */
export class SessionLauncherService extends Context.Service<SessionLauncherService, SessionLauncher>()(
  "@muximo/application/SessionLauncher",
) {}

/** Application-owned remote provider-session capability. */
export class RemoteSessionService extends Context.Service<RemoteSessionService, RemoteSession>()(
  "@muximo/application/RemoteSession",
) {}

/** Application-owned provider resource-release capability. */
export class SessionResourceService extends Context.Service<SessionResourceService, SessionResource>()(
  "@muximo/application/SessionResource",
) {}

/** Application-owned provider observation capability. */
export class AgentObservationService extends Context.Service<AgentObservationService, AgentObservation>()(
  "@muximo/application/AgentObservation",
) {}

/** Application-owned pane publication capability for agent lifecycle changes. */
export class PanePublicationService extends Context.Service<PanePublicationService, PanePublication>()(
  "@muximo/application/PanePublication",
) {}

/** Application-owned process liveness observation capability. */
export class ProcessObservationService extends Context.Service<ProcessObservationService, ProcessObservation>()(
  "@muximo/application/ProcessObservation",
) {}

/** Application-owned session-list observation capability. */
export class SessionObservationService extends Context.Service<SessionObservationService, SessionObservation>()(
  "@muximo/application/SessionObservation",
) {}

/** Clock used by the session-list projection policy. */
export class SessionListClockService extends Context.Service<SessionListClockService, SessionListClock>()(
  "@muximo/application/SessionListClock",
) {}

/** Database-only audit capability for agent-session mutations. */
export class SessionAuditService extends Context.Service<SessionAuditService, SessionAudit>()(
  "@muximo/application/SessionAudit",
) {}

/** Clock used by agent-session lifecycle transitions. */
export class SessionClockService extends Context.Service<SessionClockService, SessionClock>()(
  "@muximo/application/SessionClock",
) {}

/** Repository capability used by agent-session lifecycle use cases. */
export class ManagedAgentSessionRepositoryService extends Context.Service<
  ManagedAgentSessionRepositoryService,
  ManagedAgentSessionRepository
>()("@muximo/application/ManagedAgentSessionRepository") {}

/** Structured logger capability used by agent-session lifecycle use cases. */
export class SessionLoggerService extends Context.Service<SessionLoggerService, SessionLogger>()(
  "@muximo/application/SessionLogger",
) {}

/** Confirmation capability for destructive session cleanup. */
export class SessionCleanupConfirmationService extends Context.Service<
  SessionCleanupConfirmationService,
  SessionCleanupConfirmation
>()("@muximo/application/SessionCleanupConfirmation") {}

/** Services required by agent-session lifecycle and observation use cases. */
export type AgentSessionServices =
  | WorkspaceResolverService
  | SessionNamingService
  | HookService
  | WorktreeService
  | SessionLauncherService
  | RemoteSessionService
  | SessionResourceService
  | AgentObservationService
  | PanePublicationService
  | ProcessObservationService
  | SessionObservationService
  | SessionListClockService
  | SessionAuditService
  | SessionClockService
  | ManagedAgentSessionRepositoryService
  | SessionLoggerService
  | SessionCleanupConfirmationService;

/** Provides the workspace resolver implementation from the composition root. */
export const workspaceResolverLayer = (resolver: WorkspaceResolver): Layer.Layer<WorkspaceResolverService> =>
  Layer.succeed(WorkspaceResolverService, resolver);

/** Provides the session naming implementation from the composition root. */
export const sessionNamingLayer = (naming: SessionNaming): Layer.Layer<SessionNamingService> =>
  Layer.succeed(SessionNamingService, naming);

/** Provides the hook implementation from the composition root. */
export const hookLayer = (hooks: Hook): Layer.Layer<HookService> => Layer.succeed(HookService, hooks);

/** Provides the worktree implementation from the composition root. */
export const worktreeLayer = (worktrees: Worktree): Layer.Layer<WorktreeService> =>
  Layer.succeed(WorktreeService, worktrees);

/** Provides the session launcher implementation from the composition root. */
export const sessionLauncherLayer = (launcher: SessionLauncher): Layer.Layer<SessionLauncherService> =>
  Layer.succeed(SessionLauncherService, launcher);

/** Provides the remote session implementation from the composition root. */
export const remoteSessionLayer = (remote: RemoteSession): Layer.Layer<RemoteSessionService> =>
  Layer.succeed(RemoteSessionService, remote);

/** Provides the session resource implementation from the composition root. */
export const sessionResourceLayer = (resources: SessionResource): Layer.Layer<SessionResourceService> =>
  Layer.succeed(SessionResourceService, resources);

/** Provides the agent observation implementation from the composition root. */
export const agentObservationLayer = (observation: AgentObservation): Layer.Layer<AgentObservationService> =>
  Layer.succeed(AgentObservationService, observation);

/** Provides the pane publication implementation from the composition root. */
export const panePublicationLayer = (panes: PanePublication): Layer.Layer<PanePublicationService> =>
  Layer.succeed(PanePublicationService, panes);

/** Provides the process observation implementation from the composition root. */
export const processObservationLayer = (process: ProcessObservation): Layer.Layer<ProcessObservationService> =>
  Layer.succeed(ProcessObservationService, process);

/** Provides the session observation implementation from the composition root. */
export const sessionObservationLayer = (observation: SessionObservation): Layer.Layer<SessionObservationService> =>
  Layer.succeed(SessionObservationService, observation);

/** Provides the session-list clock from the composition root. */
export const sessionListClockLayer = (clock: SessionListClock): Layer.Layer<SessionListClockService> =>
  Layer.succeed(SessionListClockService, clock);

/** Provides the session audit implementation from the composition root. */
export const sessionAuditLayer = (audit: SessionAudit): Layer.Layer<SessionAuditService> =>
  Layer.succeed(SessionAuditService, audit);

/** Provides the session lifecycle clock from the composition root. */
export const sessionClockLayer = (clock: SessionClock): Layer.Layer<SessionClockService> =>
  Layer.succeed(SessionClockService, clock);

/** Provides the managed agent-session repository from the composition root. */
export const managedAgentSessionRepositoryLayer = (
  repository: ManagedAgentSessionRepository,
): Layer.Layer<ManagedAgentSessionRepositoryService> => Layer.succeed(ManagedAgentSessionRepositoryService, repository);

/** Provides the session logger from the composition root. */
export const sessionLoggerLayer = (logger: SessionLogger): Layer.Layer<SessionLoggerService> =>
  Layer.succeed(SessionLoggerService, logger);

/** Provides the cleanup confirmation implementation from the composition root. */
export const sessionCleanupConfirmationLayer = (
  confirmation: SessionCleanupConfirmation,
): Layer.Layer<SessionCleanupConfirmationService> => Layer.succeed(SessionCleanupConfirmationService, confirmation);

/** Assembles all agent-session services from concrete implementations. */
export type AgentSessionLayerDependencies = {
  workspace: WorkspaceResolver;
  naming: SessionNaming;
  hooks: Hook;
  worktrees: Worktree;
  launcher: SessionLauncher;
  remote: RemoteSession;
  resources: SessionResource;
  observations: AgentObservation;
  panes: PanePublication;
  process: ProcessObservation;
  sessionObservation: SessionObservation;
  listClock: SessionListClock;
  audit: SessionAudit;
  clock: SessionClock;
  sessions: ManagedAgentSessionRepository;
  logger: SessionLogger;
  confirmCleanup: SessionCleanupConfirmation;
};

export const agentSessionLayer = (dependencies: AgentSessionLayerDependencies): Layer.Layer<AgentSessionServices> =>
  Layer.mergeAll(
    workspaceResolverLayer(dependencies.workspace),
    sessionNamingLayer(dependencies.naming),
    hookLayer(dependencies.hooks),
    worktreeLayer(dependencies.worktrees),
    sessionLauncherLayer(dependencies.launcher),
    remoteSessionLayer(dependencies.remote),
    sessionResourceLayer(dependencies.resources),
    agentObservationLayer(dependencies.observations),
    panePublicationLayer(dependencies.panes),
    processObservationLayer(dependencies.process),
    sessionObservationLayer(dependencies.sessionObservation),
    sessionListClockLayer(dependencies.listClock),
    sessionAuditLayer(dependencies.audit),
    sessionClockLayer(dependencies.clock),
    managedAgentSessionRepositoryLayer(dependencies.sessions),
    sessionLoggerLayer(dependencies.logger),
    sessionCleanupConfirmationLayer(dependencies.confirmCleanup),
  );
