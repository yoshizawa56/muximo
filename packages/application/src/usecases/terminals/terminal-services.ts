import { Context, Layer } from "effect";
import type { MuximodHostPort, MuximodSessionManagementPort, MuximodViewportPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";

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
export class MuximodHostService extends Context.Service<MuximodHostService, MuximodHostPort>()(
  "@muximo/application/MuximodHost",
) {}

/** Application-owned terminal session management capability. */
export class MuximodSessionManagementService extends Context.Service<
  MuximodSessionManagementService,
  MuximodSessionManagementPort
>()("@muximo/application/MuximodSessionManagement") {}

/** Application-owned terminal viewport capability. */
export class MuximodViewportService extends Context.Service<MuximodViewportService, MuximodViewportPort>()(
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
export const muximodHostLayer = (host: MuximodHostPort): Layer.Layer<MuximodHostService> =>
  Layer.succeed(MuximodHostService, host);

/** Provides the session management implementation from the composition root. */
export const muximodSessionManagementLayer = (
  sessionManagement: MuximodSessionManagementPort,
): Layer.Layer<MuximodSessionManagementService> => Layer.succeed(MuximodSessionManagementService, sessionManagement);

/** Provides the viewport implementation from the composition root. */
export const muximodViewportLayer = (viewport: MuximodViewportPort): Layer.Layer<MuximodViewportService> =>
  Layer.succeed(MuximodViewportService, viewport);

/** Provides the in-process agent observation state from the composition root. */
export const agentStatusLayer = (agentStatus: AgentStatusStore): Layer.Layer<AgentStatusService> =>
  Layer.succeed(AgentStatusService, agentStatus);

/** Assembles the terminal service layer from concrete implementations. */
export const terminalLayer = (dependencies: {
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
  host: MuximodHostPort;
  sessionManagement: MuximodSessionManagementPort;
  viewportManager: MuximodViewportPort;
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
