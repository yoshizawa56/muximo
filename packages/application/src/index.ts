export { InvalidWorkspaceCopyPatternError, InvalidWorkspaceNameError, WorkspaceUpdateEmptyError } from "@muximo/domain";
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
} from "./ports/application.js";
export { ApplicationError, type MuximodApplication, type MuximodHookEvent } from "./ports/application.js";
export type {
  AuthCryptoPort,
  AuthStorePort,
  MuximodAuthControlPort,
  MuximodAuthPort,
} from "./ports/auth.js";
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
} from "./ports/auth-types.js";
export type {
  AgentExecutionObservation,
  MuximodHostPort,
  MuximodLiveSnapshot,
  MuximodPaneRef,
  MuximodPaneSnapshot,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
} from "./ports/host.js";
export type { PairingControlPort, PairingPresenterPort } from "./ports/pairing.js";
export type {
  ApprovedDevice,
  PairDeviceInput,
  PairingClaim,
  PairingDeviceType,
  PairingOffer,
} from "./ports/pairing-types.js";
export type { PaneGateway } from "./ports/panes.js";
export type {
  AgentSessionRepository,
  PaneFilter,
  PaneRepository,
  WorkspaceRepository,
} from "./ports/repositories.js";
export { type MuximodSocket, type MuximodSocketData, muximodSocketReadyState } from "./ports/socket.js";
export type { TransactionManager } from "./ports/transactions.js";
export type {
  WorkspaceAuditPort,
  WorkspaceDirectoryInfo,
  WorkspaceDirectoryPort,
} from "./ports/workspace.js";
export { AuthStoreError } from "./usecases/auth/auth-errors.js";
export type { AuthServiceOptions } from "./usecases/auth/auth-service.js";
export { AuthService } from "./usecases/auth/auth-service.js";
export {
  createMuximodApplication,
  type MuximodApplicationResources,
  type MuximodApplicationRuntime,
} from "./usecases/muximod/muximod-service.js";
export type { PairDeviceResult } from "./usecases/pairing/pair-device.js";
export { PairDevice } from "./usecases/pairing/pair-device.js";
export { ListPanes } from "./usecases/panes/list-panes.js";
export { ResizePane } from "./usecases/panes/resize-pane.js";
export { SendPaneInput } from "./usecases/panes/send-pane-input.js";
export {
  type AgentStatusObservation,
  type AgentStatusStore,
  agentStatusKey,
  inferUnmanagedAgentState,
  normalizeAgentStatusObservation,
  readManagedAgentObservation,
  recentAgentOutputLimits,
} from "./usecases/sessions/agent-status.js";
// Workspace use cases (one file per operation)
export { DeleteWorkspace } from "./usecases/workspaces/delete-workspace.js";
export { ListWorkspaces } from "./usecases/workspaces/list-workspaces.js";
export { RegisterWorkspace } from "./usecases/workspaces/register-workspace.js";
export { UpdateWorkspace } from "./usecases/workspaces/update-workspace.js";
export {
  WorkspaceAlreadyRegisteredError,
  WorkspaceNotFoundError,
  WorkspaceUseCaseError,
} from "./usecases/workspaces/workspace-errors.js";
export type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./usecases/workspaces/workspace-inputs.js";
export { WorkspaceRecordFactory } from "./usecases/workspaces/workspace-record-factory.js";
