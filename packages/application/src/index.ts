export { ApplicationError, type MuximodApplication, type MuximodHookEvent } from "./ports/application.js";
export {
  createMuximodApplication,
  type MuximodApplicationResources,
  type MuximodApplicationRuntime,
} from "./usecases/muximod/muximod-service.js";

export {
  agentStatusKey,
  inferUnmanagedAgentState,
  normalizeAgentStatusObservation,
  readManagedAgentObservation,
  recentAgentOutputLimits,
  type AgentStatusObservation,
  type AgentStatusStore,
} from "./usecases/sessions/agent-status.js";

export { AuthStoreError } from "./usecases/auth/auth-errors.js";
export { AuthService } from "./usecases/auth/auth-service.js";
export type { AuthServiceOptions } from "./usecases/auth/auth-service.js";
export type {
  AuthChallengeResponse,
  AuthDeviceRecord,
  AuthDeviceStatus,
  AuthDeviceType,
  AuthPairingClaimNotification,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
  AuthPairingPayload,
  AuthPairingRecord,
  AuthPairingStatus,
  AuthSessionRecord,
  AuthSessionResponse,
  ClaimPairingInput,
  ClaimPairingResult,
  CreatePairingInput,
  CreatePairingResult,
  MuximodAuthContext,
  MuximodAuthDevice,
  PublicKeyJwk,
  WsTicketResponse,
} from "./models/auth.js";
export type {
  AuthCryptoPort,
  AuthStorePort,
  MuximodAuthControlPort,
  MuximodAuthPort,
} from "./ports/auth.js";

export { muximodSocketReadyState, type MuximodSocket, type MuximodSocketData } from "./ports/socket.js";
export type {
  AgentExecutionObservation,
  MuximodHostPort,
  MuximodLiveSnapshot,
  MuximodPaneRef,
  MuximodPaneSnapshot,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
} from "./ports/host.js";
export type { TransactionManager } from "./ports/transactions.js";
export type {
  WorkspaceAuditPort,
  WorkspaceDirectoryInfo,
  WorkspaceDirectoryPort,
} from "./ports/workspace.js";

export type {
  CreatePaneInput,
  CreateSessionInput,
  MuximodPanePlacement,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
  MuximodWorkspaceDirectory,
  RegisterWorkspaceCommand,
  UpdateWorkspaceCommand,
} from "./models/muximod.js";
export type { PaneFilter } from "./models/panes.js";

export { PairDevice } from "./usecases/pairing/pair-device.js";
export type {
  ApprovedDevice,
  PairDeviceInput,
  PairDeviceResult,
  PairingClaim,
  PairingDeviceType,
  PairingOffer,
} from "./models/pairing.js";
export type { PairingControlPort, PairingPresenterPort } from "./ports/pairing.js";

export {
  DeleteWorkspace,
  InvalidWorkspaceCopyPatternError,
  InvalidWorkspaceNameError,
  ListWorkspaces,
  RegisterWorkspace,
  UpdateWorkspace,
  WorkspaceAlreadyRegisteredError,
  WorkspaceCrud,
  WorkspaceNotFoundError,
  WorkspaceRecordFactory,
  WorkspaceUpdateEmptyError,
  WorkspaceUseCaseError,
} from "./usecases/workspaces/workspace-crud.js";
export type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./models/workspace.js";

export type {
  AgentSessionRepository,
  PaneRepository,
  WorkspaceRepository,
} from "./ports/repositories.js";
export type { PaneGateway } from "./ports/panes.js";
export { ListPanes } from "./usecases/panes/list-panes.js";
export { ResizePane } from "./usecases/panes/resize-pane.js";
export { SendPaneInput } from "./usecases/panes/send-pane-input.js";
