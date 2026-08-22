import { z } from "zod";
import {
  Pane,
  PaneId,
  Workspace,
  WorkspaceId,
  agentBackendSchema,
  paneKindSchema,
  paneStateSchema,
} from "@muximo/domain";

export const protocolVersion = 1 as const;
export const terminalProtocolVersion = protocolVersion;

/** Largest image (in bytes) the mobile client may paste into a pane. */
export const maxPasteImageBytes = 10 * 1024 * 1024;
/** Base64 encoding of `maxPasteImageBytes`, used to bound the wire message. */
export const maxPasteImageBase64Length = Math.ceil(maxPasteImageBytes / 3) * 4;

export const muximodHealthSchema = z.object({
  ok: z.literal(true),
  service: z.literal("muximod"),
  protocolVersion: z.number().int().positive(),
});
export type MuximodHealth = z.infer<typeof muximodHealthSchema>;

export const muximodCapabilitiesSchema = z.object({
  protocolVersion: z.number().int().positive(),
  features: z.object({
    tmuxSessions: z.boolean(),
    terminalWebSocket: z.boolean(),
    paneState: z.boolean(),
    resourceInvalidationEvents: z.boolean(),
  }),
});
export type MuximodCapabilities = z.infer<typeof muximodCapabilitiesSchema>;

export const authDeviceTypeSchema = z.enum(["browser", "native", "cli"]);
export type AuthDeviceType = z.infer<typeof authDeviceTypeSchema>;

const base64UrlValueSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const displayValueSchema = z.string().trim().min(1).max(120).regex(/^[^\u0000\r\n]+$/);

export const publicKeyJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: base64UrlValueSchema,
  y: base64UrlValueSchema,
}).strict();
export type PublicKeyJwk = z.infer<typeof publicKeyJwkSchema>;

export const pairingQrPayloadSchema = z.object({
  v: z.literal(2),
  muximodBaseUrl: z.string().url(),
  serverId: z.string().min(16).max(256),
  pairingId: z.string().min(16).max(256),
  pairingSecret: base64UrlValueSchema.min(32).max(512),
  expiresAt: z.number().int().positive(),
}).strict();
export type PairingQrPayload = z.infer<typeof pairingQrPayloadSchema>;

export const pairingCodePayloadSchema = z.object({
  muximodBaseUrl: z.string().url(),
  pairingId: z.string().min(16).max(256),
  pairingSecret: base64UrlValueSchema.min(32).max(512),
}).strict();
export type PairingCodePayload = z.infer<typeof pairingCodePayloadSchema>;

const pairingClaimNotificationSchema = z.object({
  pairingId: z.string().min(16).max(256),
  serverId: z.string().min(16).max(256),
  deviceName: displayValueSchema,
  deviceType: authDeviceTypeSchema,
  platform: z.string().nullable(),
  clientVersion: z.string().nullable(),
  keyFingerprint: z.string().min(1).max(256),
  expiresAt: z.string().datetime(),
}).strict();
export type PairingClaimNotification = z.infer<typeof pairingClaimNotificationSchema>;

export const muximodControlRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_pairing"),
    muximodBaseUrl: z.string().url(),
  }).strict(),
  z.object({
    type: z.literal("approve_pairing"),
    pairingId: z.string().min(16).max(256),
  }).strict(),
  z.object({
    type: z.literal("reject_pairing"),
    pairingId: z.string().min(16).max(256),
  }).strict(),
  z.object({
    type: z.literal("adopt_agent_session"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
  }).strict(),
  z.object({
    type: z.literal("release_agent_session"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
  }).strict(),
  z.object({
    type: z.literal("observe_agent_session"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
    state: z.enum(["starting", "running", "waiting_input", "waiting_approval", "failed", "completed", "stopped"]),
    recentOutput: z.string().max(2_000).optional(),
  }).strict(),
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
  z.object({
    type: z.literal("pairing_created"),
    pairingId: z.string().min(16).max(256),
    pairingCode: z.string().startsWith("ma3:").min(16).max(8_192),
    payload: pairingQrPayloadSchema,
  }).strict(),
  z.object({
    type: z.literal("pairing_claimed"),
    ...pairingClaimNotificationSchema.shape,
  }).strict(),
  z.object({
    type: z.literal("pairing_result"),
    pairingId: z.string().min(16).max(256),
    status: z.enum(["approved", "rejected"]),
    deviceId: z.string().min(1).max(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("agent_session_adopted"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
  }).strict(),
  z.object({
    type: z.literal("agent_session_released"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
  }).strict(),
  z.object({
    type: z.literal("agent_session_observed"),
    agentSessionId: z.string().min(1).max(128),
    tmuxPaneId: z.string().regex(/^%[0-9]+$/),
    executionId: z.string().min(16).max(128),
    state: z.enum(["starting", "running", "waiting_input", "waiting_approval", "failed", "completed", "stopped"]),
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(4_096),
  }).strict(),
]);
export type MuximodControlResponse = z.infer<typeof muximodControlResponseSchema>;

export function decodeMuximodControlResponse(data: string | Uint8Array): ControlFrameDecode<MuximodControlResponse> {
  return decodeControlFrame(data, muximodControlResponseSchema);
}

export function encodeMuximodControlResponse(response: MuximodControlResponse): string {
  return JSON.stringify(muximodControlResponseSchema.parse(response));
}

export const authInfoSchema = z.object({
  protocolVersion: z.literal(protocolVersion),
  serverId: z.string().min(16).max(256),
  serverTime: z.string().datetime(),
}).strict();
export type AuthInfo = z.infer<typeof authInfoSchema>;

export const pairingClaimRequestSchema = z.object({
  pairingSecret: base64UrlValueSchema.min(32).max(512),
  publicKey: publicKeyJwkSchema,
  deviceName: displayValueSchema,
  deviceType: authDeviceTypeSchema,
  platform: z.string().trim().max(120).regex(/^[^\u0000\r\n]*$/).optional(),
  clientVersion: z.string().trim().max(120).regex(/^[^\u0000\r\n]*$/).optional(),
  clientNonce: base64UrlValueSchema.min(16).max(512),
  signature: base64UrlValueSchema.min(1).max(1024),
}).strict();
export type PairingClaimRequest = z.infer<typeof pairingClaimRequestSchema>;

export const pairingClaimResponseSchema = z.object({
  serverId: z.string().min(16).max(256),
  pairingId: z.string().min(16).max(256),
  claimToken: z.string().min(32).max(512),
  status: z.literal("awaiting_approval"),
  expiresAt: z.string().datetime(),
  keyFingerprint: z.string().min(1).max(256),
}).strict();
export type PairingClaimResponse = z.infer<typeof pairingClaimResponseSchema>;

export const pairingStatusSchema = z.object({
  status: z.enum(["offered", "awaiting_approval", "approved", "rejected", "expired"]),
  deviceId: z.string().min(1).max(256).nullable(),
}).strict();
export type PairingStatus = z.infer<typeof pairingStatusSchema>;

export const authChallengeRequestSchema = z.object({
  deviceId: z.string().min(1).max(256),
}).strict();
export type AuthChallengeRequest = z.infer<typeof authChallengeRequestSchema>;

export const authChallengeResponseSchema = z.object({
  serverId: z.string().min(16).max(256),
  deviceId: z.string().min(1).max(256),
  challengeId: z.string().min(16).max(256),
  nonce: base64UrlValueSchema.min(16).max(512),
  expiresAt: z.string().datetime(),
}).strict();
export type AuthChallengeResponse = z.infer<typeof authChallengeResponseSchema>;

export const authSessionRequestSchema = z.object({
  deviceId: z.string().min(1).max(256),
  challengeId: z.string().min(16).max(256),
  signature: base64UrlValueSchema.min(1).max(1024),
}).strict();
export type AuthSessionRequest = z.infer<typeof authSessionRequestSchema>;

export const authSessionResponseSchema = z.object({
  serverId: z.string().min(16).max(256),
  deviceId: z.string().min(1).max(256),
  sessionId: z.string().min(16).max(256),
  accessToken: z.string().min(32).max(512),
  expiresAt: z.string().datetime(),
}).strict();
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const wsTicketRequestSchema = z.object({
  endpoint: z.literal("terminal"),
}).strict();
export type WsTicketRequest = z.infer<typeof wsTicketRequestSchema>;

export const wsTicketResponseSchema = z.object({
  ticket: z.string().min(32).max(512),
  endpoint: z.literal("terminal"),
  expiresAt: z.string().datetime(),
}).strict();
export type WsTicketResponse = z.infer<typeof wsTicketResponseSchema>;

export const authDeviceSchema = z.object({
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
}).strict();
export type AuthDevice = z.infer<typeof authDeviceSchema>;

export const muximodEventSchema = z.object({
  type: z.literal("session_updated"),
  sessionName: z.string().min(1),
  reason: z.enum(["pane_created", "pane_deleted", "pane_changed"]),
  revision: z.number().int().nonnegative(),
});
export type MuximodEvent = z.infer<typeof muximodEventSchema>;

export const workspaceSelectionModeSchema = z.enum(["workspace", "worktree"]);
export type WorkspaceSelectionMode = z.infer<typeof workspaceSelectionModeSchema>;

const workspaceScriptPathSchema = Workspace.schema.shape.setupScriptPath.unwrap();
const workspaceScriptPatchSchema = workspaceScriptPathSchema.trim().min(1).max(4_096).nullable().optional();
const workspaceNameInputSchema = Workspace.schema.shape.name.trim().min(1).optional();
const worktreeCopyPatternSchema = Workspace.schema.shape.worktreeCopyPatterns.element;
const worktreeCopyPatternsInputSchema = z.array(worktreeCopyPatternSchema).max(100).optional();
const workspaceIdWireSchema = WorkspaceId.valueSchema;
const paneIdWireSchema = PaneId.valueSchema;

export const workspaceDirectorySchema = z.object({
  id: workspaceIdWireSchema,
  name: Workspace.schema.shape.name,
  directory: Workspace.schema.shape.rootPath,
  isGit: Workspace.schema.shape.isGit,
  setupScriptPath: workspaceScriptPathSchema.nullable(),
  cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().nullable(),
  worktreeCopyPatterns: Workspace.schema.shape.worktreeCopyPatterns,
});
export type WorkspaceDirectory = z.infer<typeof workspaceDirectorySchema>;

export const workspaceListResponseSchema = z.object({ workspaces: z.array(workspaceDirectorySchema) });

export const workspaceBrowseResponseSchema = z.object({ directories: z.array(workspaceDirectorySchema) });

export const registerWorkspaceRequestSchema = z.object({
  directory: z.string().trim().min(1).max(4_096),
  name: workspaceNameInputSchema,
  setupScriptPath: workspaceScriptPatchSchema,
  cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().trim().min(1).max(4_096).nullable().optional(),
  worktreeCopyPatterns: worktreeCopyPatternsInputSchema,
});
export type RegisterWorkspaceRequest = z.infer<typeof registerWorkspaceRequestSchema>;

export const updateWorkspaceRequestSchema = z.object({
  name: workspaceNameInputSchema,
  setupScriptPath: workspaceScriptPatchSchema,
  cleanupScriptPath: Workspace.schema.shape.cleanupScriptPath.unwrap().trim().min(1).max(4_096).nullable().optional(),
  worktreeCopyPatterns: worktreeCopyPatternsInputSchema,
  appendWorktreeCopyPatterns: worktreeCopyPatternsInputSchema,
  clearWorktreeCopyPatterns: z.boolean().optional(),
}).strict();
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const workspaceResponseSchema = z.object({ workspace: workspaceDirectorySchema });

export const workspaceSelectionSchema = z.object({
  workspaceId: workspaceIdWireSchema,
  mode: workspaceSelectionModeSchema,
});
export type WorkspaceSelection = z.infer<typeof workspaceSelectionSchema>;

const dimensionsSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(300),
});

const terminalFrameVersionSchema = z.object({
  version: z.literal(terminalProtocolVersion),
});

const terminalSessionIdSchema = z.string().min(1).max(128);
const terminalResumeTokenSchema = z.string().min(1).max(256);

const terminalAttachMessageSchema = z.object({
  type: z.literal("attach"),
  ...terminalFrameVersionSchema.shape,
  target: z.string().min(1).max(256),
  ...dimensionsSchema.shape,
  sessionId: terminalSessionIdSchema.optional(),
  resumeToken: terminalResumeTokenSchema.optional(),
}).superRefine((value, context) => {
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
  z.object({
    type: z.literal("resize"),
    ...terminalFrameVersionSchema.shape,
    ...dimensionsSchema.shape,
  }),
  z.object({
    type: z.literal("detach"),
    ...terminalFrameVersionSchema.shape,
    sessionId: terminalSessionIdSchema.optional(),
  }),
  z.object({
    type: z.literal("claim"),
    ...terminalFrameVersionSchema.shape,
  }),
  z.object({
    type: z.literal("paste_image"),
    ...terminalFrameVersionSchema.shape,
    // Display name for the inline-image protocol and for tools that read the
    // pasted file. Kept on the client because the OS picker knows it.
    name: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f:;]+$/, "name contains a control character, ':' or ';'"),
    mimeType: z.string().trim().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/).optional(),
    // Standard base64 (with padding) so muximod can decode without URL handling.
    data: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(1).max(maxPasteImageBase64Length),
  }),
]);

export type ClientControlMessage = z.infer<typeof clientControlMessageSchema>;

export type ClientControlFrameDecode =
  | { ok: true; message: ClientControlMessage }
  | { ok: false; code: "invalid_json" | "unsupported_version" | "invalid_message"; message: string };

/** Decodes and validates a text WebSocket control frame at the protocol boundary. */
export function decodeClientControlFrame(data: string | Uint8Array): ClientControlFrameDecode {
  let input: unknown;
  try {
    input = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as unknown;
  } catch {
    return { ok: false, code: "invalid_json", message: "Invalid JSON control frame" };
  }

  if (isRecord(input) && "version" in input && input.version !== terminalProtocolVersion) {
    return { ok: false, code: "unsupported_version", message: `Unsupported terminal protocol version: ${String(input.version)}` };
  }

  const parsed = clientControlMessageSchema.safeParse(input);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, code: "invalid_message", message: parsed.error.message };
}

export const paneSummarySchema = z.object({
  id: paneIdWireSchema,
  tmuxPaneId: Pane.schema.shape.tmuxPaneId,
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
  // Present for live tmux snapshots. Older persisted rows may omit geometry;
  // the client falls back to a readable stacked layout in that case.
  windowName: Pane.schema.shape.windowName,
  windowIndex: Pane.schema.shape.windowIndex,
  // Pane indexes are scoped to a tmux window and are distinct from tmuxPaneId
  // (the server-wide target such as %32).
  paneIndex: Pane.schema.shape.paneIndex,
  left: Pane.schema.shape.left,
  top: Pane.schema.shape.top,
  width: Pane.schema.shape.width,
  height: Pane.schema.shape.height,
  windowWidth: Pane.schema.shape.windowWidth,
  windowHeight: Pane.schema.shape.windowHeight,
});

export const paneListResponseSchema = z.object({ panes: z.array(paneSummarySchema) });
export type PaneSummary = z.infer<typeof paneSummarySchema>;

export const panePlacementSchema = z.enum(["window", "right", "bottom"]);
export type PanePlacement = z.infer<typeof panePlacementSchema>;

export const createPaneRequestSchema = z.object({
  sessionName: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  kind: z.enum(["agent", "shell"]),
  name: z.string().trim().min(1).max(120).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "name contains a control character"),
  // cwd remains readable for older clients and is used only as a new-window
  // initial directory. Split panes always inherit the target pane cwd.
  cwd: z.string().trim().min(1).max(4_096).optional(),
  workspaceId: workspaceIdWireSchema.optional(),
  agentId: agentBackendSchema.nullable(),
  useWorktree: z.boolean(),
  placement: panePlacementSchema,
  targetPaneId: z.string().trim().min(1).max(64).nullable(),
}).superRefine((value, context) => {
  if (value.cwd && value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "choose workspaceId instead of cwd" });
  }
  if (value.placement !== "window" && value.cwd) {
    context.addIssue({ code: "custom", path: ["cwd"], message: "split panes always inherit the target pane cwd" });
  }
  if (value.placement !== "window" && value.workspaceId && !value.useWorktree) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "workspaceId on a split pane requires useWorktree" });
  }
  if (value.kind === "agent" && !value.agentId) {
    context.addIssue({ code: "custom", path: ["agentId"], message: "agentId is required for an agent pane" });
  }
  if (value.kind === "shell" && value.agentId) {
    context.addIssue({ code: "custom", path: ["agentId"], message: "agentId is not allowed for a shell pane" });
  }
  if (value.placement === "window" && value.targetPaneId) {
    context.addIssue({ code: "custom", path: ["targetPaneId"], message: "targetPaneId is only used for a split pane" });
  }
  if (value.placement !== "window" && !value.targetPaneId) {
    context.addIssue({ code: "custom", path: ["targetPaneId"], message: "targetPaneId is required for a split pane" });
  }
});
export type CreatePaneRequest = z.infer<typeof createPaneRequestSchema>;

export const paneResponseSchema = z.object({ pane: paneSummarySchema });

export const terminalEndpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  host: z.string().min(1),
  tailnetIp: z.string().min(1),
  state: z.enum(["online", "offline"]),
  detail: z.string(),
  lastSeen: z.string(),
});
export type TerminalEndpoint = z.infer<typeof terminalEndpointSchema>;

export const terminalListResponseSchema = z.object({ terminals: z.array(terminalEndpointSchema) });

export const tmuxSessionSchema = z.object({
  name: z.string().min(1),
  paneCount: z.number().int().min(0),
  waitingCount: z.number().int().min(0),
  detail: z.string(),
});
export type TmuxSession = z.infer<typeof tmuxSessionSchema>;

export const sessionListResponseSchema = z.object({ sessions: z.array(tmuxSessionSchema) });

export const createSessionRequestSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  // cwd is accepted only as a compatibility input. The web flow always sends
  // workspaceId, which is resolved on the host before tmux is touched.
  cwd: z.string().trim().min(1).max(4_096).optional(),
  workspaceId: workspaceIdWireSchema.optional(),
}).superRefine((value, context) => {
  if (!value.cwd && !value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "workspaceId or cwd is required" });
  }
  if (value.cwd && value.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "choose workspaceId instead of cwd" });
  }
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionResponseSchema = z.object({ session: tmuxSessionSchema });

export const serverControlMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    ...terminalFrameVersionSchema.shape,
    sessionId: terminalSessionIdSchema,
    resumeToken: terminalResumeTokenSchema,
    resumed: z.boolean(),
    target: z.string(),
    paneId: z.string(),
    windowId: z.string(),
    ...dimensionsSchema.shape,
  }),
  z.object({
    type: z.literal("viewport"),
    ...terminalFrameVersionSchema.shape,
    owner: z.enum(["mobile", "desktop"]),
    reason: z.enum(["attached", "mobile_claim", "desktop_activity", "desktop_resize", "desktop_focus", "detached"]),
  }),
  z.object({
    type: z.literal("error"),
    ...terminalFrameVersionSchema.shape,
    sessionId: terminalSessionIdSchema.optional(),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("closed"),
    ...terminalFrameVersionSchema.shape,
    sessionId: terminalSessionIdSchema,
    reason: z.enum(["detached", "terminal_exit", "network_timeout", "server_shutdown"]),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
]);

export type ServerControlMessage = z.infer<typeof serverControlMessageSchema>;

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

function decodeControlFrame<T>(data: string | Uint8Array, schema: { safeParse: (input: unknown) => unknown }): ControlFrameDecode<T> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export * from "./auth-crypto.js";
