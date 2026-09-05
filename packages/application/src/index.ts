export { InvalidWorkspaceNameError, WorkspaceUpdateEmptyError } from "@muximo/domain";
export { attemptSync } from "./attempt.js";
export type { ApplicationEffect } from "./effect.js";
export { type ApplicationClock, ApplicationClockService, applicationClockLayer } from "./effect-runtime.js";
export type {
  AgentBackendResumeState,
  AgentExecutionReceipt,
  AgentExecutionResult,
  AgentExecutionSpec,
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
  HookResult,
  HookSessionUpdate,
  LaunchPreparation,
  ManagedWorktreeState,
  PreparedAgentSession,
  ProcessLiveness,
  ProcessResult,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  RunAgentSessionResult,
  SessionBaselineResult,
  SessionIdentityUpdate,
  StartAgentSessionInput,
  WorkspaceResolutionInput,
  WorkspaceScope,
} from "./ports/agent-sessions.js";
export type {
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
export {
  ApplicationError,
  ApplicationFailure,
  type ApplicationFailureReason,
  type MuximodApplication,
  type TerminalHostHookEvent,
} from "./ports/application.js";
export type {
  ChallengeRateWindow,
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
  DaemonEnsureResult,
  DaemonHealthFailureContext,
  DaemonHealthFailureReason,
  DaemonOptions,
  DaemonPidRecord,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
} from "./ports/daemon.js";
export { DaemonHealthError } from "./ports/daemon.js";
export type {
  AgentExecutionObservation,
  HostPaneReference,
  HostPaneSnapshot,
  MuximodPaneClassification,
  MuximodPaneObservation,
  TerminalHostSnapshot,
} from "./ports/host.js";
export type {
  ApprovedDevice,
  PairDeviceInput,
  PairingClaim,
  PairingDeviceType,
  PairingOffer,
} from "./ports/pairing-types.js";
export type {
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
  PaneFilter,
} from "./ports/repositories.js";
export type {
  RunShellInput,
  ShellProcessInput,
  ShellWorktree,
  ShellWorktreeAllocation,
} from "./ports/shell.js";
export type { WorkspaceDirectoryInfo } from "./ports/workspace.js";
export {
  type AgentObservation,
  AgentObservationService,
  type AgentSessionLayerDependencies,
  type AgentSessionServices,
  agentObservationLayer,
  agentSessionLayer,
  type Hook,
  HookService,
  hookLayer,
  type ManagedAgentSessionRepository,
  ManagedAgentSessionRepositoryService,
  managedAgentSessionRepositoryLayer,
  type PanePublication,
  PanePublicationService,
  type ProcessObservation,
  ProcessObservationService,
  panePublicationLayer,
  processObservationLayer,
  type RemoteSession,
  RemoteSessionService,
  remoteSessionLayer,
  type SessionAudit,
  SessionAuditService,
  type SessionCleanupConfirmation,
  SessionCleanupConfirmationService,
  type SessionClock,
  SessionClockService,
  type SessionLauncher,
  SessionLauncherService,
  type SessionListClock,
  SessionListClockService,
  type SessionLogger,
  SessionLoggerService,
  type SessionNaming,
  SessionNamingService,
  type SessionObservation,
  SessionObservationService,
  type SessionResource,
  SessionResourceService,
  sessionAuditLayer,
  sessionCleanupConfirmationLayer,
  sessionClockLayer,
  sessionLauncherLayer,
  sessionListClockLayer,
  sessionLoggerLayer,
  sessionNamingLayer,
  sessionObservationLayer,
  sessionResourceLayer,
  type WorkspaceResolver,
  WorkspaceResolverService,
  type Worktree,
  WorktreeService,
  workspaceResolverLayer,
  worktreeLayer,
} from "./usecases/agent-sessions/agent-session-services.js";
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
export { AttachAgentSession } from "./usecases/agents/attach-agent-session.js";
export { AuthStoreError } from "./usecases/auth/auth-errors.js";
export type { AuthServiceOptions } from "./usecases/auth/auth-service.js";
export { AuthService } from "./usecases/auth/auth-service.js";
export {
  type AuthChallengeStore,
  AuthChallengeStoreService,
  type AuthClock,
  AuthClockService,
  type AuthConnection,
  AuthConnectionService,
  type AuthCrypto,
  AuthCryptoService,
  type AuthPairingClaimSink,
  AuthPairingClaimSinkService,
  type AuthRateLimitStore,
  AuthRateLimitStoreService,
  AuthServerIdService,
  type AuthServices,
  type AuthStore,
  AuthStoreService,
  type AuthWsTicketStore,
  AuthWsTicketStoreService,
  authChallengeStoreLayer,
  authClockLayer,
  authConnectionLayer,
  authCryptoLayer,
  authLayer,
  authPairingClaimSinkLayer,
  authRateLimitStoreLayer,
  authServerIdLayer,
  authStoreLayer,
  authWsTicketStoreLayer,
  type MuximodAuth,
  type MuximodAuthControl,
  MuximodAuthControlService,
  MuximodAuthService,
  muximodAuthControlLayer,
  muximodAuthLayer,
} from "./usecases/auth/auth-services.js";
export { authChallengeTtlMs, authRateWindowMax, authRateWindowMs } from "./usecases/auth/create-challenge.js";
export {
  type DaemonClock,
  DaemonClockService,
  type DaemonLifecycleConfig,
  DaemonLifecycleConfigService,
  type DaemonProcessHandle,
  type DaemonRuntime,
  DaemonRuntimeService,
  type DaemonScheduler,
  DaemonSchedulerService,
  type DaemonServices,
  daemonClockLayer,
  daemonLayer,
  daemonLifecycleConfigLayer,
  daemonRuntimeLayer,
  daemonSchedulerLayer,
} from "./usecases/daemon/daemon-services.js";
export { EnsureDaemon } from "./usecases/daemon/ensure-daemon.js";
export { RestartDaemon } from "./usecases/daemon/restart-daemon.js";
export { StartDaemon, type StartDaemonInput } from "./usecases/daemon/start-daemon.js";
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
  type PairingControl,
  PairingControlService,
  type PairingPresenter,
  PairingPresenterService,
  type PairingServices,
  pairingControlLayer,
  pairingLayer,
  pairingPresenterLayer,
} from "./usecases/pairing/pairing-services.js";
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
  type SessionWorktreeLookup,
  SessionWorktreeLookupService,
  type ShellContext,
  type ShellHook,
  ShellHookService,
  type ShellPane,
  ShellPaneService,
  type ShellProcess,
  ShellProcessService,
  type ShellServices,
  type ShellWorkspaceResolver,
  ShellWorkspaceResolverService,
  type ShellWorktreeOperations,
  ShellWorktreeService,
  sessionWorktreeLookupLayer,
  shellContextLayer,
  shellHookLayer,
  shellLayer,
  shellPaneLayer,
  shellProcessLayer,
  shellWorkspaceResolverLayer,
  shellWorktreeLayer,
} from "./usecases/shell/shell-services.js";
export {
  type AgentSessionRepository,
  AgentSessionRepositoryService,
  AgentStatusService,
  agentSessionRepositoryLayer,
  agentStatusLayer,
  type MuximodHost,
  MuximodHostService,
  type MuximodSessionManagement,
  MuximodSessionManagementService,
  type MuximodTerminalObservation,
  type MuximodViewport,
  MuximodViewportService,
  muximodHostLayer,
  muximodSessionManagementLayer,
  muximodViewportLayer,
  type PaneRepository,
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
  type MuximodWorkspaceCatalog,
  MuximodWorkspaceCatalogService,
  noopWorkspaceAuditLayer,
  passthroughTransactionManagerLayer,
  type TransactionManager,
  TransactionManagerService,
  transactionManagerLayer,
  type WorkspaceAudit,
  WorkspaceAuditService,
  type WorkspaceDirectory,
  WorkspaceDirectoryService,
  type WorkspaceRepository,
  WorkspaceRepositoryService,
  type WorkspaceServices,
  workspaceAuditLayer,
  workspaceCatalogLayer,
  workspaceDirectoryLayer,
  workspaceLayer,
  workspaceRepositoryLayer,
} from "./usecases/workspaces/workspace-services.js";
