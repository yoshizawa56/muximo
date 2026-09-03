import {
  AgentSession,
  agentBackendSchema,
  Pane,
  PaneId,
  paneKindSchema,
  paneStateSchema,
  Workspace,
  WorkspaceId,
} from "@muximo/domain";
import { z } from "zod";

/**
 * Version for the public HTTP and terminal contracts. The private control
 * socket is a same-user, matched CLI/daemon channel and intentionally has no
 * compatibility version; changing its schemas is a breaking change that must
 * ship with both sides together.
 */
export const protocolVersion = 2 as const;
export const terminalProtocolVersion = protocolVersion;
export const muximodControlMaxRequestBytes = 64 * 1024;
export const muximodControlMaxResponseBytes = 4 * 1024 * 1024;
export const muximodControlMaxBufferedResponseBytes = 8 * 1024 * 1024;
export const muximodControlMaxPendingRequests = 128;

const operationIdWireSchema = z.string().min(16).max(128);
const operationIdempotencyKeySchema = z.string().trim().min(1).max(256);
const operationStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const operationErrorSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(4_096),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const operationStatusSchema = z
  .object({
    operationId: operationIdWireSchema,
    kind: z.string().min(1).max(120),
    state: operationStateSchema,
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime(),
    result: z.unknown().optional(),
    error: operationErrorSchema.optional(),
    diagnostic: z.string().trim().min(1).max(4_096).optional(),
    logReference: z.string().trim().min(1).max(4_096).optional(),
    cancelRequestedAt: z.string().datetime().optional(),
  })
  .strict();
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const operationAcceptedResponseSchema = z.object({ operation: operationStatusSchema }).strict();
export type OperationAcceptedResponse = z.infer<typeof operationAcceptedResponseSchema>;

/** Largest image (in bytes) the mobile client may paste into a pane. */
export const maxPasteImageBytes = 10 * 1024 * 1024;
/** Base64 encoding of `maxPasteImageBytes`, used to bound the wire message. */
export const maxPasteImageBase64Length = Math.ceil(maxPasteImageBytes / 3) * 4;

export const muximodHealthSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("muximod"),
    protocolVersion: z.literal(protocolVersion),
    pid: z.number().int().positive(),
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MuximodHealth = z.infer<typeof muximodHealthSchema>;

export const muximodCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    features: z
      .object({
        tmuxSessions: z.boolean(),
        terminalWebSocket: z.boolean(),
        paneState: z.boolean(),
        resourceInvalidationEvents: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type MuximodCapabilities = z.infer<typeof muximodCapabilitiesSchema>;

export const authDeviceTypeSchema = z.enum(["browser", "native", "cli"]);
export type AuthDeviceType = z.infer<typeof authDeviceTypeSchema>;

const base64UrlValueSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const displayValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[^\u0000\r\n]+$/);
const controlRequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const agentExecutionCommandSchema = z.array(z.string().max(16_384)).min(1).max(256);
const agentExecutionEnvironmentSchema = z
  .record(z.string().min(1).max(256), z.string().max(64 * 1024))
  .refine((value) => Object.keys(value).length <= 1_024, "environment has too many entries");
const agentExecutionProcessResultSchema = z
  .object({
    started: z.boolean(),
    code: z.number().int(),
    interrupted: z.boolean(),
    signal: z.string().max(32).nullable().optional(),
    failureDiagnostic: z.string().trim().min(1).max(4_096).optional(),
    pid: z.number().int().positive().optional(),
  })
  .strict();
const cleanupReasonWireSchema = z.enum([
  "cleanup_declined",
  "remote_archive_failed",
  "remote_restore_failed",
  "cleanup_hook_failed",
  "unregistered_worktree",
  "worktree_removal_failed",
]);
const cleanupResultWireSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("removed") }).strict(),
  z.object({ disposition: z.literal("retained"), reason: cleanupReasonWireSchema }).strict(),
  z.object({ disposition: z.literal("failed"), reason: cleanupReasonWireSchema }).strict(),
]);
const runCleanupResultWireSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("not_requested"), reason: z.enum(["interrupted", "no_worktree"]) }).strict(),
  ...cleanupResultWireSchema.options,
]);

const hostPaneIdWireSchema = z.string().regex(/^%[0-9]+$/);

const agentSessionWorkspaceScopeInputSchema = z.enum(["current", "all"]);
const agentSessionArgumentSchema = z.string().max(4_096);
const agentSessionStartInputSchema = z
  .object({
    backend: agentBackendSchema,
    name: AgentSession.schema.shape.name.optional(),
    hostPaneId: hostPaneIdWireSchema.optional(),
    workspace: z.string().trim().min(1).max(4_096).optional(),
    cwd: z.string().trim().min(1).max(4_096).optional(),
    useWorktree: z.boolean(),
    worktreeRoot: z.string().trim().min(1).max(4_096).optional(),
    setupHook: z.string().trim().min(1).max(4_096).optional(),
    cleanupHook: z.string().trim().min(1).max(4_096).optional(),
    setupHookExplicit: z.boolean(),
    cleanupHookExplicit: z.boolean(),
    backendArgs: z.array(agentSessionArgumentSchema).max(256),
    idempotencyKey: operationIdempotencyKeySchema.optional(),
    executionOwnerPid: z.number().int().positive().optional(),
  })
  .strict();
const agentSessionResumeInputSchema = z
  .object({
    workspaceScope: agentSessionWorkspaceScopeInputSchema,
    reference: z.string().trim().min(1).max(256),
    hostPaneId: hostPaneIdWireSchema.optional(),
    backendArgs: z.array(agentSessionArgumentSchema).max(256),
    idempotencyKey: operationIdempotencyKeySchema.optional(),
    executionOwnerPid: z.number().int().positive().optional(),
  })
  .strict();
const agentExecutionPlanSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    executionId: z.string().min(16).max(128),
    sessionName: z.string().min(1).max(120),
    backend: agentBackendSchema,
    command: agentExecutionCommandSchema,
    cwd: z.string().min(1).max(4_096),
    environment: agentExecutionEnvironmentSchema,
  })
  .strict();
const agentSessionRecordWireSchema = AgentSession.schema;

export const tmuxSessionNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "URL must use http or https without credentials");

export const publicKeyJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: base64UrlValueSchema,
    y: base64UrlValueSchema,
  })
  .strict();
export type PublicKeyJwk = z.infer<typeof publicKeyJwkSchema>;

export const pairingQrPayloadSchema = z
  .object({
    v: z.literal(2),
    muximodBaseUrl: httpUrlSchema,
    serverId: z.string().min(16).max(256),
    pairingId: z.string().min(16).max(256),
    pairingSecret: base64UrlValueSchema.min(32).max(512),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type PairingQrPayload = z.infer<typeof pairingQrPayloadSchema>;

export const pairingCodePayloadSchema = z
  .object({
    muximodBaseUrl: httpUrlSchema,
    pairingId: z.string().min(16).max(256),
    pairingSecret: base64UrlValueSchema.min(32).max(512),
  })
  .strict();
export type PairingCodePayload = z.infer<typeof pairingCodePayloadSchema>;

const localAuthSessionResponseSchema = z
  .object({
    serverId: z.string().min(16).max(256),
    deviceId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    accessToken: base64UrlValueSchema.min(32).max(512),
    expiresAt: z.string().datetime(),
  })
  .strict();

const pairingClaimNotificationSchema = z
  .object({
    pairingId: z.string().min(16).max(256),
    serverId: z.string().min(16).max(256),
    deviceName: displayValueSchema,
    deviceType: authDeviceTypeSchema,
    platform: z.string().nullable(),
    clientVersion: z.string().nullable(),
    keyFingerprint: z.string().min(1).max(256),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PairingClaimNotification = z.infer<typeof pairingClaimNotificationSchema>;

export const muximodControlRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create_local_session"), requestId: controlRequestIdSchema }).strict(),
  z
    .object({
      type: z.literal("create_pairing"),
      requestId: controlRequestIdSchema,
      muximodBaseUrl: httpUrlSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("approve_pairing"),
      requestId: controlRequestIdSchema,
      pairingId: z.string().min(16).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("reject_pairing"),
      requestId: controlRequestIdSchema,
      pairingId: z.string().min(16).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("adopt_agent_session"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("release_agent_session"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("observe_agent_session"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
      state: z.enum(["starting", "running", "waiting_input", "waiting_approval", "failed", "completed", "stopped"]),
      recentOutput: z.string().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("read_log"),
      requestId: controlRequestIdSchema,
      lines: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z.discriminatedUnion("operation", [
    z
      .object({
        type: z.literal("prepare_agent_execution"),
        requestId: controlRequestIdSchema,
        operation: z.literal("run"),
        input: agentSessionStartInputSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("prepare_agent_execution"),
        requestId: controlRequestIdSchema,
        operation: z.literal("resume"),
        input: agentSessionResumeInputSchema,
      })
      .strict(),
  ]),
  z
    .object({
      type: z.literal("attach_agent_execution"),
      requestId: controlRequestIdSchema,
      operation: z.enum(["run", "resume"]),
      operationId: operationIdWireSchema,
      agentSessionId: z.string().min(1).max(128),
      executionId: z.string().min(16).max(128),
      hostPaneId: hostPaneIdWireSchema.optional(),
      executionPid: z.number().int().positive(),
      executionStartedAt: z.string().datetime(),
      executionOwnerPid: z.number().int().positive().optional(),
      executionOwnerStartedAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("complete_agent_execution"),
      requestId: controlRequestIdSchema,
      operation: z.enum(["run", "resume"]),
      operationId: operationIdWireSchema,
      agentSessionId: z.string().min(1).max(128),
      executionId: z.string().min(16).max(128),
      hostPaneId: hostPaneIdWireSchema.optional(),
      result: agentExecutionProcessResultSchema,
    })
    .strict(),
]);
export type MuximodControlRequest = z.infer<typeof muximodControlRequestSchema>;

export type ControlFrameDecode<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid_json" | "invalid_shape"; message: string };

export function decodeMuximodControlRequest(data: string | Uint8Array): ControlFrameDecode<MuximodControlRequest> {
  return decodeControlFrame(data, muximodControlRequestSchema);
}

export function encodeMuximodControlRequest(request: MuximodControlRequest): string {
  return JSON.stringify(muximodControlRequestSchema.parse(request));
}

export const muximodControlResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("local_session_created"),
      requestId: controlRequestIdSchema,
      session: localAuthSessionResponseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pairing_created"),
      requestId: controlRequestIdSchema,
      pairingId: z.string().min(16).max(256),
      pairingCode: z.string().startsWith("ma3:").min(16).max(8_192),
      payload: pairingQrPayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("pairing_claimed"),
      ...pairingClaimNotificationSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("pairing_result"),
      requestId: controlRequestIdSchema,
      pairingId: z.string().min(16).max(256),
      status: z.enum(["approved", "rejected"]),
      deviceId: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_session_adopted"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_session_released"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_session_observed"),
      requestId: controlRequestIdSchema,
      agentSessionId: z.string().min(1).max(128),
      hostPaneId: hostPaneIdWireSchema,
      executionId: z.string().min(16).max(128),
      state: z.enum(["starting", "running", "waiting_input", "waiting_approval", "failed", "completed", "stopped"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("daemon_log"),
      requestId: controlRequestIdSchema,
      state: z.enum(["available", "empty", "missing"]),
      logFile: z.string().min(1),
      lines: z.array(z.string()).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_execution_prepared"),
      requestId: controlRequestIdSchema,
      operation: z.enum(["run", "resume"]),
      operationId: operationIdWireSchema,
      agentSessionId: z.string().min(1).max(128),
      executionId: z.string().min(16).max(128),
      hostPaneId: hostPaneIdWireSchema.optional(),
      session: agentSessionRecordWireSchema,
      execution: agentExecutionPlanSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_execution_attached"),
      requestId: controlRequestIdSchema,
      operationId: operationIdWireSchema,
      agentSessionId: z.string().min(1).max(128),
      executionId: z.string().min(16).max(128),
      executionPid: z.number().int().positive(),
      executionStartedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent_execution_completed"),
      requestId: controlRequestIdSchema,
      operation: z.enum(["run", "resume"]),
      operationId: operationIdWireSchema,
      agentSessionId: z.string().min(1).max(128),
      executionId: z.string().min(16).max(128),
      process: agentExecutionProcessResultSchema,
      session: agentSessionRecordWireSchema,
      cleanup: runCleanupResultWireSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      requestId: controlRequestIdSchema.optional(),
      code: z.string().min(1).max(120),
      message: z.string().min(1).max(4_096),
    })
    .strict(),
]);
export type MuximodControlResponse = z.infer<typeof muximodControlResponseSchema>;

export type MuximodControlLogResult = Pick<
  Extract<MuximodControlResponse, { type: "daemon_log" }>,
  "state" | "logFile" | "lines"
>;

export function decodeMuximodControlResponse(data: string | Uint8Array): ControlFrameDecode<MuximodControlResponse> {
  return decodeControlFrame(data, muximodControlResponseSchema);
}

export function encodeMuximodControlResponse(response: MuximodControlResponse): string {
  return JSON.stringify(muximodControlResponseSchema.parse(response));
}

export const authInfoSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    serverId: z.string().min(16).max(256),
    serverTime: z.string().datetime(),
  })
  .strict();
export type AuthInfo = z.infer<typeof authInfoSchema>;

export const pairingClaimRequestSchema = z
  .object({
    pairingSecret: base64UrlValueSchema.min(32).max(512),
    publicKey: publicKeyJwkSchema,
    deviceName: displayValueSchema,
    deviceType: authDeviceTypeSchema,
    platform: z
      .string()
      .trim()
      .max(120)
      .regex(/^[^\u0000\r\n]*$/)
      .optional(),
    clientVersion: z
      .string()
      .trim()
      .max(120)
      .regex(/^[^\u0000\r\n]*$/)
      .optional(),
    clientNonce: base64UrlValueSchema.min(16).max(512),
    signature: base64UrlValueSchema.min(1).max(1024),
  })
  .strict();
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;

export const pairingClaimResponseSchema = z
  .object({
    serverId: z.string().min(16).max(256),
    pairingId: z.string().min(16).max(256),
    claimToken: z.string().min(32).max(512),
    status: z.literal("awaiting_approval"),
    expiresAt: z.string().datetime(),
    keyFingerprint: z.string().min(1).max(256),
  })
  .strict();
export type PairingClaimResponse = z.infer<typeof pairingClaimResponseSchema>;

export const pairingStatusSchema = z
  .object({
    status: z.enum(["offered", "awaiting_approval", "approved", "rejected", "expired"]),
    deviceId: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type PairingStatus = z.infer<typeof pairingStatusSchema>;

export const authChallengeRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
  })
  .strict();
export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;

export const authChallengeResponseSchema = z
  .object({
    serverId: z.string().min(16).max(256),
    deviceId: z.string().min(1).max(256),
    challengeId: z.string().min(16).max(256),
    nonce: base64UrlValueSchema.min(16).max(512),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AuthChallengeResponse = z.infer<typeof authChallengeResponseSchema>;

export const authSessionRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
    challengeId: z.string().min(16).max(256),
    signature: base64UrlValueSchema.min(1).max(1024),
  })
  .strict();
export type AuthSessionRequest = z.infer<typeof authSessionRequestSchema>;

export const authSessionResponseSchema = z
  .object({
    serverId: z.string().min(16).max(256),
    deviceId: z.string().min(1).max(256),
    sessionId: z.string().min(16).max(256),
    accessToken: z.string().min(32).max(512),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const wsTicketRequestSchema = z
  .object({
    endpoint: z.literal("terminal"),
  })
  .strict();
export type WsTicketRequest = z.infer<typeof wsTicketRequestSchema>;

export const wsTicketResponseSchema = z
  .object({
    ticket: z.string().min(32).max(512),
    endpoint: z.literal("terminal"),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;

export const authDeviceSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(120),
    deviceType: authDeviceTypeSchema,
    platform: z.string().nullable(),
    clientVersion: z.string().nullable(),
    keyFingerprint: z.string().min(1).max(256),
    status: z.enum(["active", "revoked"]),
    createdAt: z.string().datetime(),
    lastSeenAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
  })
  .strict();
export type AuthDevice = z.infer<typeof authDeviceSchema>;

export const muximodEventSchema = z
  .object({
    type: z.literal("session_updated"),
    sessionName: z.string().min(1),
    reason: z.enum(["pane_created", "pane_deleted", "pane_changed"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export type MuximodEvent = z.infer<typeof muximodEventSchema>;

export const workspaceSelectionModeSchema = z.enum(["workspace", "worktree"]);
export type WorkspaceSelectionMode = z.infer<typeof workspaceSelectionModeSchema>;

const workspaceScriptPathSchema = Workspace.schema.shape.setupScriptPath.unwrap();
const workspaceScriptPatchSchema = workspaceScriptPathSchema.trim().min(1).max(4_096).nullable().optional();
const workspaceNameInputSchema = Workspace.schema.shape.name.trim().min(1).optional();
const workspaceIdWireSchema = WorkspaceId.valueSchema;
const paneIdWireSchema = PaneId.valueSchema;

export const workspaceDirectorySchema = z
  .object({
    id: workspaceIdWireSchema,
    name: Workspace.schema.shape.name,
    directory: Workspace.schema.shape.rootPath,
    isGit: Workspace.schema.shape.isGit,
    setupScriptPath: workspaceScriptPathSchema.nullable(),
    cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().nullable(),
  })
  .strict();
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

export const workspaceListResponseSchema = z.object({ workspaces: z.array(workspaceDirectorySchema) }).strict();

export const workspaceBrowseResponseSchema = z.object({ directories: z.array(workspaceDirectorySchema) }).strict();

export const registerWorkspaceRequestSchema = z
  .object({
    directory: z.string().trim().min(1).max(4_096),
    name: workspaceNameInputSchema,
    setupScriptPath: workspaceScriptPatchSchema,
    cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().trim().min(1).max(4_096).nullable().optional(),
  })
  .strict();
export type RegisterWorkspaceRequest = z.infer<typeof registerWorkspaceRequestSchema>;

export const updateWorkspaceRequestSchema = z
  .object({
    name: workspaceNameInputSchema,
    setupScriptPath: workspaceScriptPatchSchema,
    cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().trim().min(1).max(4_096).nullable().optional(),
  })
  .strict();
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const workspaceResponseSchema = z.object({ workspace: workspaceDirectorySchema }).strict();

export const workspaceSelectionSchema = z
  .object({
    workspaceId: workspaceIdWireSchema,
    mode: workspaceSelectionModeSchema,
  })
  .strict();
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

export const agentSessionWorkspaceScopeSchema = agentSessionWorkspaceScopeInputSchema;
export type AgentSessionWorkspaceScope = z.infer<typeof agentSessionWorkspaceScopeSchema>;

export const cleanupAgentSessionRequestSchema = z
  .object({
    workspaceScope: agentSessionWorkspaceScopeSchema,
    force: z.boolean(),
    reference: z.string().trim().min(1).max(256),
    idempotencyKey: operationIdempotencyKeySchema.optional(),
  })
  .strict();
export type CleanupAgentSessionRequest = z.infer<typeof cleanupAgentSessionRequestSchema>;

export const listAgentSessionsRequestSchema = z
  .object({
    workspaceScope: agentSessionWorkspaceScopeSchema,
    includeUnavailable: z.boolean(),
  })
  .strict();
export type ListAgentSessionsRequest = z.infer<typeof listAgentSessionsRequestSchema>;

export const processResultSchema = z
  .object({
    started: z.boolean(),
    code: z.number().int(),
    interrupted: z.boolean(),
    signal: z.string().nullable().optional(),
    failureDiagnostic: z.string().trim().min(1).max(4_096).optional(),
  })
  .strict();
export type ProcessResult = z.infer<typeof processResultSchema>;

export const cleanupReasonSchema = cleanupReasonWireSchema;
export type CleanupReason = z.infer<typeof cleanupReasonSchema>;

export const cleanupResultSchema = cleanupResultWireSchema;
export type CleanupResult = z.infer<typeof cleanupResultSchema>;

export const runCleanupResultSchema = runCleanupResultWireSchema;
export type RunCleanupResult = z.infer<typeof runCleanupResultSchema>;

export const agentSessionRecordSchema = agentSessionRecordWireSchema;
export type AgentSessionRecord = z.infer<typeof agentSessionRecordSchema>;

export const agentSessionExecutionHealthSchema = z.enum(["inactive", "active", "long_running", "stale", "unknown"]);
export type AgentSessionExecutionHealth = z.infer<typeof agentSessionExecutionHealthSchema>;

export const agentSessionResumeStateSchema = z.enum(["available", "unavailable", "unknown"]);
export type AgentSessionResumeState = z.infer<typeof agentSessionResumeStateSchema>;

export const agentSessionResumeReasonSchema = z
  .enum([
    "backend_session_missing",
    "backend_session_discovery_required",
    "currently_running",
    "execution_state_unknown",
    "not_resumable_state",
    "worktree_missing",
    "worktree_state_unknown",
    "worktree_unregistered",
  ])
  .nullable();
export type AgentSessionResumeReason = z.infer<typeof agentSessionResumeReasonSchema>;

export const agentSessionWorktreeStateSchema = z.enum([
  "not_applicable",
  "available",
  "missing",
  "unregistered",
  "unknown",
]);
export type AgentSessionWorktreeState = z.infer<typeof agentSessionWorktreeStateSchema>;

export const agentSessionListProjectionSchema = z
  .object({
    session: agentSessionRecordSchema,
    executionHealth: agentSessionExecutionHealthSchema,
    resume: agentSessionResumeStateSchema,
    resumeReason: agentSessionResumeReasonSchema,
    worktreeState: agentSessionWorktreeStateSchema,
    visibleByDefault: z.boolean(),
  })
  .strict();
export type AgentSessionListProjection = z.infer<typeof agentSessionListProjectionSchema>;

export const agentSessionListResponseSchema = z
  .object({
    allViews: z.array(agentSessionListProjectionSchema),
    views: z.array(agentSessionListProjectionSchema),
  })
  .strict();
export type AgentSessionListResponse = z.infer<typeof agentSessionListResponseSchema>;

export const runAgentSessionResponseSchema = z
  .object({
    process: processResultSchema,
    session: agentSessionRecordSchema,
    cleanup: runCleanupResultSchema,
  })
  .strict();
export type RunAgentSessionResponse = z.infer<typeof runAgentSessionResponseSchema>;

export const resumeAgentSessionResponseSchema = z
  .object({
    process: processResultSchema,
    session: agentSessionRecordSchema,
  })
  .strict();
export type ResumeAgentSessionResponse = z.infer<typeof resumeAgentSessionResponseSchema>;

export const cleanupAgentSessionResponseSchema = z
  .object({
    session: agentSessionRecordSchema,
    cleanup: cleanupResultSchema,
  })
  .strict();
export type CleanupAgentSessionResponse = z.infer<typeof cleanupAgentSessionResponseSchema>;

const dimensionsSchema = z
  .object({
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(300),
  })
  .strict();

const terminalFrameVersionSchema = z
  .object({
    version: z.literal(terminalProtocolVersion),
  })
  .strict();

const terminalSessionIdSchema = z.string().min(1).max(128);
const terminalResumeTokenSchema = z.string().min(1).max(256);

const terminalAttachMessageSchema = z
  .object({
    type: z.literal("attach"),
    ...terminalFrameVersionSchema.shape,
    target: z.string().min(1).max(256),
    ...dimensionsSchema.shape,
    sessionId: terminalSessionIdSchema.optional(),
    resumeToken: terminalResumeTokenSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.sessionId === undefined) !== (value.resumeToken === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.sessionId === undefined ? "sessionId" : "resumeToken"],
        message: "sessionId and resumeToken must be provided together",
      });
    }
  });

export const clientControlMessageSchema = z.discriminatedUnion("type", [
  terminalAttachMessageSchema,
  z
    .object({
      type: z.literal("resize"),
      ...terminalFrameVersionSchema.shape,
      ...dimensionsSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("redraw"),
      ...terminalFrameVersionSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
      ...terminalFrameVersionSchema.shape,
      nonce: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("detach"),
      ...terminalFrameVersionSchema.shape,
      sessionId: terminalSessionIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("claim"),
      ...terminalFrameVersionSchema.shape,
      ...dimensionsSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("enter_copy_mode"),
      ...terminalFrameVersionSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("paste_tmux_buffer"),
      ...terminalFrameVersionSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("paste_image"),
      ...terminalFrameVersionSchema.shape,
      // Display name for the inline-image protocol and for tools that read the
      // pasted file. Kept on the client because the OS picker knows it.
      name: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(/^[^\u0000-\u001f\u007f:;]+$/, "name contains a control character, ':' or ';'"),
      mimeType: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(/^[^\u0000-\u001f\u007f]+$/)
        .optional(),
      // Standard base64 (with padding) so muximod can decode without URL handling.
      data: z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/)
        .min(1)
        .max(maxPasteImageBase64Length),
    })
    .strict(),
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

type TerminalControlFrameDecode<T> =
  | { ok: true; message: T }
  | { ok: false; code: "invalid_json" | "unsupported_version" | "invalid_message"; message: string };

export type ClientControlFrameDecode = TerminalControlFrameDecode<ClientControlMessage>;

/** Validates and encodes a client control message for a text WebSocket frame. */
export function encodeClientControlFrame(message: ClientControlMessage): string {
  return JSON.stringify(clientControlMessageSchema.parse(message));
}

/** Decodes and validates a text WebSocket control frame at the protocol boundary. */
export function decodeClientControlFrame(data: string | Uint8Array): ClientControlFrameDecode {
  return decodeTerminalControlFrame(data, clientControlMessageSchema);
}

export const paneSummarySchema = z
  .object({
    id: paneIdWireSchema,
    hostPaneId: hostPaneIdWireSchema,
    sessionName: Pane.schema.shape.sessionName,
    windowId: Pane.schema.shape.windowId,
    kind: paneKindSchema,
    name: Pane.schema.shape.name,
    cwd: Pane.schema.shape.cwd,
    workspaceId: workspaceIdWireSchema.nullable(),
    agentId: Pane.schema.shape.agentId.unwrap().nullable(),
    state: paneStateSchema,
    title: Pane.schema.shape.title.unwrap().nullable(),
    // Live-only output tail. It is intentionally bounded and omitted from
    // persisted pane rows so the pane list remains a small status projection.
    recentOutput: Pane.schema.shape.recentOutput.unwrap().max(2_000).optional(),
    lastSeenAt: Pane.schema.shape.lastSeenAt,
    // Live tmux geometry used by the pane layout.
    windowName: Pane.schema.shape.windowName,
    windowIndex: Pane.schema.shape.windowIndex,
    // Pane indexes are scoped to a tmux window and are distinct from hostPaneId
    // (the server-wide target such as %32).
    paneIndex: Pane.schema.shape.paneIndex,
    left: Pane.schema.shape.left,
    top: Pane.schema.shape.top,
    width: Pane.schema.shape.width,
    height: Pane.schema.shape.height,
    windowWidth: Pane.schema.shape.windowWidth,
    windowHeight: Pane.schema.shape.windowHeight,
  })
  .strict();

export const paneListResponseSchema = z.object({ panes: z.array(paneSummarySchema) }).strict();
export type PaneSummary = z.infer<typeof paneSummarySchema>;

export const panePlacementSchema = z.enum(["window", "right", "bottom"]);
export type PanePlacement = z.infer<typeof panePlacementSchema>;

export const createPaneRequestSchema = z
  .object({
    sessionName: tmuxSessionNameSchema,
    kind: z.enum(["agent", "shell"]),
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "name contains a control character"),
    workspaceId: workspaceIdWireSchema.optional(),
    agentId: agentBackendSchema.nullable(),
    useWorktree: z.boolean(),
    placement: panePlacementSchema,
    targetPaneId: z.string().trim().min(1).max(64).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.placement !== "window" && value.workspaceId && !value.useWorktree) {
      context.addIssue({
        code: "custom",
        path: ["workspaceId"],
        message: "workspaceId on a split pane requires useWorktree",
      });
    }
    if (value.kind === "agent" && !value.agentId) {
      context.addIssue({ code: "custom", path: ["agentId"], message: "agentId is required for an agent pane" });
    }
    if (value.kind === "shell" && value.agentId) {
      context.addIssue({ code: "custom", path: ["agentId"], message: "agentId is not allowed for a shell pane" });
    }
    if (value.placement === "window" && value.targetPaneId) {
      context.addIssue({
        code: "custom",
        path: ["targetPaneId"],
        message: "targetPaneId is only used for a split pane",
      });
    }
    if (value.placement !== "window" && !value.targetPaneId) {
      context.addIssue({
        code: "custom",
        path: ["targetPaneId"],
        message: "targetPaneId is required for a split pane",
      });
    }
  });
export type CreatePaneRequest = z.infer<typeof createPaneRequestSchema>;

export const paneResponseSchema = z.object({ pane: paneSummarySchema }).strict();

export const terminalEndpointSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    host: z.string().min(1),
    tailnetIp: z.string().min(1),
    state: z.enum(["online", "offline"]),
    detail: z.string(),
    lastSeen: z.string(),
  })
  .strict();
export type TerminalEndpoint = z.infer<typeof terminalEndpointSchema>;

export const terminalListResponseSchema = z.object({ terminals: z.array(terminalEndpointSchema) }).strict();

export const tmuxSessionSchema = z
  .object({
    name: z.string().min(1),
    paneCount: z.number().int().min(0),
    waitingCount: z.number().int().min(0),
    detail: z.string(),
    managed: z.boolean(),
  })
  .strict();
export type TmuxSession = z.infer<typeof tmuxSessionSchema>;

export const sessionListResponseSchema = z.object({ sessions: z.array(tmuxSessionSchema) }).strict();

export const manageSessionRequestSchema = z
  .object({
    name: tmuxSessionNameSchema,
  })
  .strict();
export type ManageSessionRequest = z.infer<typeof manageSessionRequestSchema>;

export const managedSessionResponseSchema = z
  .object({
    session: z
      .object({
        name: z.string().min(1),
        changed: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const createSessionRequestSchema = z
  .object({
    name: tmuxSessionNameSchema,
    workspaceId: workspaceIdWireSchema,
  })
  .strict();
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionResponseSchema = z.object({ session: tmuxSessionSchema }).strict();

export const serverControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("ready"),
      ...terminalFrameVersionSchema.shape,
      sessionId: terminalSessionIdSchema,
      resumeToken: terminalResumeTokenSchema,
      resumed: z.boolean(),
      target: z.string(),
      paneId: z.string(),
      windowId: z.string(),
      owner: z.enum(["mobile", "desktop"]),
      sync: z.enum(["live", "replay", "redraw"]),
      ...dimensionsSchema.shape,
    })
    .strict(),
  z
    .object({
      type: z.literal("viewport"),
      ...terminalFrameVersionSchema.shape,
      owner: z.enum(["mobile", "desktop"]),
      reason: z.enum([
        "attached",
        "mobile_claim",
        "desktop_activity",
        "desktop_resize",
        "desktop_focus",
        "transport_lost",
        "detached",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("pong"),
      ...terminalFrameVersionSchema.shape,
      nonce: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("error"),
      ...terminalFrameVersionSchema.shape,
      sessionId: terminalSessionIdSchema.optional(),
      code: z.string(),
      message: z.string(),
      retryable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("closed"),
      ...terminalFrameVersionSchema.shape,
      sessionId: terminalSessionIdSchema,
      reason: z.enum(["detached", "terminal_exit", "network_timeout", "server_shutdown"]),
      code: z.number().int().nullable(),
      signal: z.string().nullable(),
    })
    .strict(),
]);

export type ServerControlMessage = z.infer<typeof serverControlMessageSchema>;

export type ServerControlFrameDecode = TerminalControlFrameDecode<ServerControlMessage>;

/** Decodes and validates a text WebSocket control frame at the protocol boundary. */
export function decodeServerControlFrame(data: string | Uint8Array): ServerControlFrameDecode {
  return decodeTerminalControlFrame(data, serverControlMessageSchema);
}

/** Validates and encodes a server control message for a text WebSocket frame. */
export function encodeServerControlFrame(message: ServerControlMessage): string {
  return JSON.stringify(serverControlMessageSchema.parse(message));
}

/** Decodes standard (non-URL) base64 payloads used by image paste frames. */
export function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64 payload");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeControlFrame<T>(
  data: string | Uint8Array,
  schema: { safeParse: (input: unknown) => unknown },
): ControlFrameDecode<T> {
  let input: unknown;
  try {
    input = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as unknown;
  } catch {
    return { ok: false, code: "invalid_json", message: "control frame must be valid JSON" };
  }

  const parsed = schema.safeParse(input) as {
    success: boolean;
    data?: T;
  };
  return parsed.success
    ? { ok: true, value: parsed.data as T }
    : { ok: false, code: "invalid_shape", message: "control frame has an invalid shape" };
}

function decodeTerminalControlFrame<T>(data: string | Uint8Array, schema: z.ZodType<T>): TerminalControlFrameDecode<T> {
  let input: unknown;
  try {
    input = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
  } catch {
    return { ok: false, code: "invalid_json", message: "Invalid JSON control frame" };
  }

  if (isRecord(input) && "version" in input && input.version !== terminalProtocolVersion) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `Unsupported terminal protocol version: ${String(input.version)}`,
    };
  }

  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, code: "invalid_message", message: parsed.error.message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export * from "./auth-crypto.js";
