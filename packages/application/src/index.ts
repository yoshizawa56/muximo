export { InvalidWorkspaceNameError, WorkspaceUpdateEmptyError } from "@muximo/domain";
export type { ApplicationEffect } from "./effect.js";
export { ApplicationClockService, applicationClockLayer } from "./effect-runtime.js";
export type {
  AgentBackendResumeState,
  AgentExecutionReceipt,
  AgentExecutionResult,
  AgentExecutionSpec,
  AgentObservationPort,
  AgentSessionExecutionHealth,
  AgentSessionListInput,
  AgentSessionListObservation,
  AgentSessionListProjection,
  AgentSessionListResult,
  AgentSessionResumeReason,
  AgentSessionResumeState,
  AgentSessionWorktreeState,
  AgentStateObservation,
  AttachAgentSessionInput,
  CleanupAgentSessionInput,
  CleanupAgentSessionResult,
  CleanupDisposition,
  CleanupReason,
  CleanupResult,
  CompleteAgentSessionInput,
  HookPort,
  HookResult,
  HookSessionUpdate,
  LaunchPreparation,
  ManagedAgentSessionRepository,
  ManagedWorktreeState,
  PanePublicationPort,
  PreparedAgentSession,
  ProcessLiveness,
  ProcessObservationPort,
  ProcessResult,
  RemoteSessionPort,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  RunAgentSessionResult,
  SessionAuditPort,
  SessionBaselineResult,
  SessionCleanupConfirmationPort,
  SessionClock,
  SessionIdentityUpdate,
  SessionLauncherPort,
  SessionListClock,
  SessionLogger,
  SessionNamingPort,
  SessionObservationPort,
  SessionResourcePort,
  StartAgentSessionInput,
  WorkspaceResolutionInput,
  WorkspaceResolverPort,
  WorkspaceScope,
  WorktreePort,
} from "./ports/agent-sessions.js";
export type {
  ApplicationClock,
  CreatePaneInput,
  CreateSessionInput,
  ManageSessionInput,
  ManageSessionResult,
  MuximodAgentSessionApplication,
  MuximodPanePlacement,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
  MuximodWorkspaceDirectory,
  RegisterWorkspaceCommand,
  UpdateWorkspaceCommand,
} from "./ports/application.js";
export { ApplicationError, type MuximodApplication, type TerminalHostHookEvent } from "./ports/application.js";
export type {
  AuthChallengeStorePort,
  AuthConnectionPort,
  AuthCryptoPort,
  AuthPairingClaimSinkPort,
  AuthRateLimitStorePort,
  AuthStorePort,
  AuthWsTicketStorePort,
  ChallengeRateWindow,
  Clock,
  MuximodAuthControlPort,
  MuximodAuthPort,
  PendingChallengeRecord,
  PendingWsTicketRecord,
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
  DaemonClock,
  DaemonEnsureResult,
  DaemonHealthFailureContext,
  DaemonHealthFailureReason,
  DaemonOptions,
  DaemonPidRecord,
  DaemonProcessHandle,
  DaemonRestartResult,
  DaemonRuntimePort,
  DaemonScheduler,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
} from "./ports/daemon.js";
export { DaemonHealthError } from "./ports/daemon.js";
export type {
  AgentExecutionObservation,
  HostPaneReference,
  HostPaneSnapshot,
  MuximodHostPort,
  MuximodPaneClassification,
  MuximodPaneObservation,
  MuximodSessionManagementPort,
  MuximodTerminalObservationPort,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
  TerminalHostSnapshot,
} from "./ports/host.js";
export type { PairingControlPort, PairingPresenterPort } from "./ports/pairing.js";
export type {
  ApprovedDevice,
  PairDeviceInput,
  PairingClaim,
  PairingDeviceType,
  PairingOffer,
} from "./ports/pairing-types.js";
export type {
  AgentSessionRepository,
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
  PaneFilter,
  PaneRepository,
  WorkspaceRepository,
} from "./ports/repositories.js";
export type {
  RunShellDependencies,
  RunShellInput,
  SessionWorktreeLookupPort,
  ShellHookPort,
  ShellPanePort,
  ShellProcessInput,
  ShellProcessPort,
  ShellWorkspaceResolverPort,
  ShellWorktree,
  ShellWorktreeAllocation,
  ShellWorktreePort,
} from "./ports/shell.js";
export type { TransactionManager } from "./ports/transactions.js";
export type {
  WorkspaceAuditPort,
  WorkspaceDirectoryInfo,
  WorkspaceDirectoryPort,
} from "./ports/workspace.js";
export { CleanupAgentSession } from "./usecases/agent-sessions/cleanup-session.js";
export {
  ListAgentSessions,
  projectAgentSession,
  sessionListPolicy,
  shouldCheckAgentSessionWorktree,
} from "./usecases/agent-sessions/list-sessions.js";
export { LocateAgentSession } from "./usecases/agent-sessions/locate-session.js";
export { ResumeAgentSession } from "./usecases/agent-sessions/resume-session.js";
export { RunAgentSession } from "./usecases/agent-sessions/run-session.js";
export { AttachAgentSession, type AttachAgentSessionDependencies } from "./usecases/agents/attach-agent-session.js";
export { AuthStoreError } from "./usecases/auth/auth-errors.js";
export type { AuthServiceOptions } from "./usecases/auth/auth-service.js";
export { AuthService } from "./usecases/auth/auth-service.js";
export { authChallengeTtlMs, authRateWindowMax, authRateWindowMs } from "./usecases/auth/create-challenge.js";
export { EnsureDaemon } from "./usecases/daemon/ensure-daemon.js";
export { RestartDaemon, type RestartDaemonDependencies } from "./usecases/daemon/restart-daemon.js";
export { StartDaemon, type StartDaemonDependencies, type StartDaemonInput } from "./usecases/daemon/start-daemon.js";
export { StatusDaemon } from "./usecases/daemon/status-daemon.js";
export { StopDaemon } from "./usecases/daemon/stop-daemon.js";
export {
  createMuximodApplication,
  type MuximodApplicationResources,
  type MuximodApplicationRuntime,
} from "./usecases/muximod/muximod-service.js";
export type { PairDeviceResult } from "./usecases/pairing/pair-device.js";
export { PairDevice } from "./usecases/pairing/pair-device.js";
export {
  type AgentStatusObservation,
  type AgentStatusStore,
  agentStatusKey,
  normalizeAgentStatusObservation,
  readManagedAgentObservation,
  recentAgentOutputLimits,
} from "./usecases/sessions/agent-status.js";
export { manageSession } from "./usecases/sessions/manage-session.js";
export { RunShell, type RunShellResult } from "./usecases/shell/run-shell.js";
export {
  AgentSessionRepositoryService,
  AgentStatusService,
  agentSessionRepositoryLayer,
  agentStatusLayer,
  MuximodHostService,
  MuximodSessionManagementService,
  MuximodViewportService,
  muximodHostLayer,
  muximodSessionManagementLayer,
  muximodViewportLayer,
  PaneRepositoryService,
  paneRepositoryLayer,
  type TerminalServices,
  terminalLayer,
} from "./usecases/terminals/terminal-services.js";
// Workspace use cases (one file per operation)
export { deleteWorkspace } from "./usecases/workspaces/delete-workspace.js";
export { listWorkspaces } from "./usecases/workspaces/list-workspaces.js";
export { registerWorkspace } from "./usecases/workspaces/register-workspace.js";
export { updateWorkspace } from "./usecases/workspaces/update-workspace.js";
export {
  WorkspaceAlreadyRegisteredError,
  WorkspaceNotFoundError,
  WorkspaceUseCaseError,
} from "./usecases/workspaces/workspace-errors.js";
export type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./usecases/workspaces/workspace-inputs.js";
export { createWorkspaceRecord, updateWorkspaceRecord } from "./usecases/workspaces/workspace-record-factory.js";
export {
  MuximodWorkspaceCatalogService,
  noopWorkspaceAuditLayer,
  passthroughTransactionManagerLayer,
  TransactionManagerService,
  transactionManagerLayer,
  WorkspaceAuditService,
  WorkspaceDirectoryService,
  WorkspaceRepositoryService,
  type WorkspaceServices,
  workspaceAuditLayer,
  workspaceCatalogLayer,
  workspaceDirectoryLayer,
  workspaceLayer,
  workspaceRepositoryLayer,
} from "./usecases/workspaces/workspace-services.js";
