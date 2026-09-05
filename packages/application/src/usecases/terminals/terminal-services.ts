import type { AgentSession, Pane, PaneState, Workspace } from "@muximo/domain";
import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { CreatePaneInput, MuximodPanePlacement } from "../../ports/application.js";
import type {
  HostPaneReference,
  MuximodPaneClassification,
  MuximodPaneObservation,
  TerminalHostSnapshot,
} from "../../ports/host.js";
import type {
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
  PaneFilter,
} from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";

export interface PaneRepository {
  list(filter?: PaneFilter): ApplicationEffect<Pane[]>;
  findById(id: Pane["id"]): ApplicationEffect<Pane | undefined>;
  findByHostPaneIdentity(hostServerId: string, hostPaneId: string): ApplicationEffect<Pane | undefined>;
  upsert(record: Pane): ApplicationEffect<void>;
  pruneStalePanes(
    activePaneIds: readonly Pane["id"][],
    olderThan: string,
    hostServerScope: string,
  ): ApplicationEffect<number>;
}

export interface AgentSessionRepository {
  findById(id: AgentSession["id"]): ApplicationEffect<AgentSession | undefined>;
  findByName(workspaceId: Workspace["id"], name: string): ApplicationEffect<AgentSession | undefined>;
  list(workspaceId?: Workspace["id"]): ApplicationEffect<AgentSession[]>;
  insert(record: AgentSession): ApplicationEffect<void>;
  update(record: AgentSession): ApplicationEffect<void>;
  claimExecution(input: ClaimExecutionInput): ApplicationEffect<boolean>;
  claimAbandonedExecution(input: ClaimAbandonedExecutionInput): ApplicationEffect<boolean>;
  attachExecution(input: AttachExecutionInput): ApplicationEffect<boolean>;
  setBackendSessionIdIfMissing(id: AgentSession["id"], backendSessionId: string): ApplicationEffect<boolean>;
  delete(id: AgentSession["id"]): ApplicationEffect<void>;
}

export interface MuximodSessionManagement {
  newId(): string;
  hasSession(target: string): ApplicationEffect<boolean>;
  findManagedSessionId(target: string): ApplicationEffect<string | undefined>;
  configureManagedSession(target: string, managedSessionId: string): ApplicationEffect<void>;
}

export interface MuximodTerminalObservation {
  classifyCommand(command: string): ApplicationEffect<MuximodPaneClassification>;
  observeUnmanagedAgent(paneId: string, fallbackState: PaneState): ApplicationEffect<MuximodPaneObservation>;
}

export interface MuximodHost extends MuximodTerminalObservation {
  newId(): string;
  hasSession(target: string): ApplicationEffect<boolean>;
  createManagedSession(target: string, cwd: string): ApplicationEffect<string>;
  killSession(target: string): ApplicationEffect<void>;
  attachSession(target: string): ApplicationEffect<number>;
  createManagedPane(
    input: CreatePaneInput,
    workspace: Workspace | undefined,
    cwd: string | undefined,
  ): ApplicationEffect<string>;
  resolvePane(target: string): ApplicationEffect<HostPaneReference>;
  isWindowZoomed(pane: HostPaneReference): ApplicationEffect<boolean>;
  splitPane(
    command: string | undefined,
    placement: Exclude<MuximodPanePlacement, "window">,
    targetPaneId: string,
    zoomed: boolean,
  ): ApplicationEffect<string>;
  listPanesSnapshot(): ApplicationEffect<TerminalHostSnapshot>;
  setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): ApplicationEffect<void>;
  setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): ApplicationEffect<void>;
  clearAgentExecutionMetadata(paneId: string, expectedExecutionId?: string): ApplicationEffect<boolean>;
  resetAgentPaneMetadata(paneId: string): ApplicationEffect<void>;
  isProcessAlive(pid: number, expectedStartedAt?: string): ApplicationEffect<boolean>;
}

export interface MuximodViewport {
  handleTerminalHostHook(
    event: "client-attached" | "client-active" | "client-resized" | "client-focus-in" | "client-detached",
    client: string,
  ): ApplicationEffect<void>;
  reassertMobileViewport(target: string): ApplicationEffect<void>;
}

/** Application-owned pane persistence capability. */
export class PaneRepositoryService extends Context.Service<PaneRepositoryService, PaneRepository>()(
  "@muximo/application/PaneRepository",
) {}

/** Application-owned agent session persistence capability. */
export class AgentSessionRepositoryService extends Context.Service<
  AgentSessionRepositoryService,
  AgentSessionRepository
>()("@muximo/application/AgentSessionRepository") {}

/** Application-owned terminal host capability. */
export class MuximodHostService extends Context.Service<MuximodHostService, MuximodHost>()(
  "@muximo/application/MuximodHost",
) {}

/** Application-owned terminal session management capability. */
export class MuximodSessionManagementService extends Context.Service<
  MuximodSessionManagementService,
  MuximodSessionManagement
>()("@muximo/application/MuximodSessionManagement") {}

/** Application-owned terminal viewport capability. */
export class MuximodViewportService extends Context.Service<MuximodViewportService, MuximodViewport>()(
  "@muximo/application/MuximodViewport",
) {}

/** In-process agent observation state; owned by the composition root. */
export class AgentStatusService extends Context.Service<AgentStatusService, AgentStatusStore>()(
  "@muximo/application/AgentStatus",
) {}

/** Services required by the sessions, panes, and terminals use cases. */
export type TerminalServices =
  | PaneRepositoryService
  | AgentSessionRepositoryService
  | MuximodHostService
  | MuximodSessionManagementService
  | MuximodViewportService
  | AgentStatusService;

/** Provides the pane repository implementation from the composition root. */
export const paneRepositoryLayer = (repository: PaneRepository): Layer.Layer<PaneRepositoryService> =>
  Layer.succeed(PaneRepositoryService, repository);

/** Provides the agent session repository implementation from the composition root. */
export const agentSessionRepositoryLayer = (
  repository: AgentSessionRepository,
): Layer.Layer<AgentSessionRepositoryService> => Layer.succeed(AgentSessionRepositoryService, repository);

/** Provides the terminal host implementation from the composition root. */
export const muximodHostLayer = (host: MuximodHost): Layer.Layer<MuximodHostService> =>
  Layer.succeed(MuximodHostService, host);

/** Provides the session management implementation from the composition root. */
export const muximodSessionManagementLayer = (
  sessionManagement: MuximodSessionManagement,
): Layer.Layer<MuximodSessionManagementService> => Layer.succeed(MuximodSessionManagementService, sessionManagement);

/** Provides the viewport implementation from the composition root. */
export const muximodViewportLayer = (viewport: MuximodViewport): Layer.Layer<MuximodViewportService> =>
  Layer.succeed(MuximodViewportService, viewport);

/** Provides the in-process agent observation state from the composition root. */
export const agentStatusLayer = (agentStatus: AgentStatusStore): Layer.Layer<AgentStatusService> =>
  Layer.succeed(AgentStatusService, agentStatus);

/** Assembles the terminal service layer from concrete implementations. */
export const terminalLayer = (dependencies: {
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
  host: MuximodHost;
  sessionManagement: MuximodSessionManagement;
  viewportManager: MuximodViewport;
  agentStatus: AgentStatusStore;
}): Layer.Layer<TerminalServices> =>
  Layer.mergeAll(
    paneRepositoryLayer(dependencies.paneRepository),
    agentSessionRepositoryLayer(dependencies.agentSessionRepository),
    muximodHostLayer(dependencies.host),
    muximodSessionManagementLayer(dependencies.sessionManagement),
    muximodViewportLayer(dependencies.viewportManager),
    agentStatusLayer(dependencies.agentStatus),
  );
