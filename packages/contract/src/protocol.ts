import {
  AgentSessionFields,
  agentBackendSchema,
  PaneFields,
  paneKindSchema,
  paneStateSchema,
  WorkspaceFields,
  workspaceSelectionModeSchema,
} from "@muximo/domain";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Effect, Result, Schema, SchemaParser } from "effect";

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

/** Largest image (in bytes) the mobile client may paste into a pane. */
export const maxPasteImageBytes = 10 * 1024 * 1024;
/** Base64 encoding of `maxPasteImageBytes`, used to bound the wire message. */
export const maxPasteImageBase64Length = Math.ceil(maxPasteImageBytes / 3) * 4;

/**
 * Exposes an Effect schema to oRPC and other Standard Schema consumers with
 * the repository's strict excess-property policy baked in.
 */
export const wire = <S extends Schema.Constraint>(schema: S): StandardSchemaV1<S["Encoded"], S["Type"]> & S =>
  Schema.toStandardSchemaV1(schema as unknown as Schema.ConstraintDecoder<unknown>, {
    parseOptions: { onExcessProperty: "error" },
  }) as unknown as StandardSchemaV1<S["Encoded"], S["Type"]> & S;

/** Defines a strict wire object. Unknown fields are rejected, never stripped. */
export const struct = <const Fields extends Schema.Struct.Fields>(fields: Fields) => wire(Schema.Struct(fields));

/**
 * Builds one tagged member of a discriminated union. The tag literal is
 * injected first so the tag value stays the single source of truth.
 */
const unionCase = <Tag extends string, Value extends string, Fields extends Schema.Struct.Fields>(
  tag: Tag,
  value: Value,
  fields: Fields,
) => {
  const tagSchema = Schema.Literal(value);
  const member = Schema.Struct({
    [tag]: tagSchema,
    ...fields,
  } as unknown as Record<Tag, typeof tagSchema> & Fields);
  return [value, member] as const;
};

type UnionMembers<Cases extends ReadonlyArray<readonly [string, Schema.Constraint]>> = {
  [I in keyof Cases]: Cases[I] extends readonly [string, infer S extends Schema.Constraint] ? S : never;
};

/**
 * Defines a tag-dispatched union of wire objects. Decoding selects members by
 * the tag value (trying same-tag members in order), so nested failures keep
 * the exact member paths instead of degrading to tag mismatches.
 */
export const discriminatedUnion = <
  Tag extends string,
  const Cases extends ReadonlyArray<readonly [string, Schema.Constraint]>,
>(
  tag: Tag,
  cases: Cases,
): StandardSchemaV1<Schema.Union<UnionMembers<Cases>>["Encoded"], Schema.Union<UnionMembers<Cases>>["Type"]> &
  Schema.Union<UnionMembers<Cases>> => {
  type MemberSchema = Cases[number] extends readonly [string, infer S extends Schema.Constraint] ? S : never;
  const groups = new Map<unknown, Array<MemberSchema>>();
  const ordered: Array<MemberSchema> = [];
  for (const [value, schema] of cases) {
    ordered.push(schema as MemberSchema);
    const group = groups.get(value);
    if (group) group.push(schema as MemberSchema);
    else groups.set(value, [schema as MemberSchema]);
  }
  const dispatch = Schema.declareConstructor<unknown>()([], () => (input, _self, options) => {
    const candidates =
      typeof input === "object" && input !== null
        ? (groups.get((input as Record<PropertyKey, unknown>)[tag]) ?? null)
        : null;
    const members = candidates ?? ordered;
    const [first, ...rest] = members;
    if (first === undefined) throw new Error("discriminated union requires at least one member");
    const decode = (member: MemberSchema) =>
      SchemaParser.decodeUnknownResult(member as unknown as Schema.ConstraintDecoder<unknown>, options)(input);
    const results = [first, ...rest].map(decode);
    for (const result of results) {
      if (Result.isSuccess(result)) return Effect.succeed(result.success);
    }
    const [firstResult] = results;
    if (firstResult !== undefined && Result.isFailure(firstResult)) return Effect.fail(firstResult.failure);
    throw new Error("discriminated union requires at least one member");
  });
  return wire(dispatch as unknown as Schema.Union<UnionMembers<Cases>>);
};

const boundedString = (minLength: number, maxLength: number) =>
  Schema.Trim.check(Schema.isMinLength(minLength), Schema.isMaxLength(maxLength));

const unboundedTrimmedString = (maxLength: number) => Schema.Trim.check(Schema.isMaxLength(maxLength));

const intInRange = (minimum: number, maximum: number) =>
  Schema.makeFilter((value: number) => Number.isInteger(value) && value >= minimum && value <= maximum);

const positiveInt = Schema.makeFilter((value: number) => Number.isInteger(value) && value > 0);

const nonNegativeInt = Schema.makeFilter((value: number) => Number.isInteger(value) && value >= 0);

const dateTimeString = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  ),
);

const httpUrlString = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }),
);

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

export const muximodHealthSchema = struct({
  ok: Schema.Literal(true),
  service: Schema.Literal("muximod"),
  protocolVersion: Schema.Literal(protocolVersion),
  pid: Schema.Int.check(positiveInt),
  configurationFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type MuximodHealth = (typeof muximodHealthSchema)["Type"];

export const muximodCapabilitiesSchema = struct({
  protocolVersion: Schema.Literal(protocolVersion),
  features: struct({
    tmuxSessions: Schema.Boolean,
    terminalWebSocket: Schema.Boolean,
    paneState: Schema.Boolean,
    resourceInvalidationEvents: Schema.Boolean,
  }),
});
export type MuximodCapabilities = (typeof muximodCapabilitiesSchema)["Type"];

export const authDeviceTypeSchema = Schema.Literals(["browser", "native", "cli"]);
export type AuthDeviceType = (typeof authDeviceTypeSchema)["Type"];

const base64UrlValueSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const displayValueSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(120),
  Schema.isPattern(/^[^\u0000\r\n]+$/),
);
const controlRequestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const agentSessionArgumentSchema = Schema.String.check(Schema.isMaxLength(4_096));
const agentSessionWorkspaceScopeInputSchema = Schema.Literals(["current", "all"]);
const agentSessionStartInputSchema = struct({
  backend: agentBackendSchema,
  name: Schema.optional(AgentSessionFields.name),
  hostPaneId: Schema.optional(Schema.String.check(Schema.isPattern(/^%[0-9]+$/))),
  workspace: Schema.optional(boundedString(1, 4_096)),
  cwd: Schema.optional(boundedString(1, 4_096)),
  useWorktree: Schema.Boolean,
  worktreeRoot: Schema.optional(boundedString(1, 4_096)),
  setupHook: Schema.optional(boundedString(1, 4_096)),
  cleanupHook: Schema.optional(boundedString(1, 4_096)),
  setupHookExplicit: Schema.Boolean,
  cleanupHookExplicit: Schema.Boolean,
  backendArgs: Schema.Array(agentSessionArgumentSchema).check(Schema.isMaxLength(256)),
  executionOwnerPid: Schema.optional(Schema.Int.check(positiveInt)),
});
const agentSessionResumeInputSchema = struct({
  workspaceScope: agentSessionWorkspaceScopeInputSchema,
  reference: boundedString(1, 256),
  hostPaneId: Schema.optional(Schema.String.check(Schema.isPattern(/^%[0-9]+$/))),
  backendArgs: Schema.Array(agentSessionArgumentSchema).check(Schema.isMaxLength(256)),
  executionOwnerPid: Schema.optional(Schema.Int.check(positiveInt)),
});
const agentExecutionPlanSchema = struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  executionId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128)),
  sessionName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  backend: agentBackendSchema,
  command: Schema.Array(Schema.String.check(Schema.isMaxLength(16_384))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  environment: Schema.Record(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    Schema.String.check(Schema.isMaxLength(64 * 1024)),
  ).check(Schema.makeFilter((value) => Object.keys(value).length <= 1_024)),
});

/**
 * Wire representation of an agent session record. The shape is declared
 * explicitly (rather than reusing the domain class) so wire evolution stays
 * versioned behind `protocolVersion`; field rules still come from the domain.
 */
export const agentSessionRecordSchema = struct({
  id: AgentSessionFields.id,
  name: AgentSessionFields.name,
  backend: AgentSessionFields.backend,
  status: AgentSessionFields.status,
  workspaceId: AgentSessionFields.workspaceId,
  workspaceRoot: AgentSessionFields.workspaceRoot,
  workspaceName: AgentSessionFields.workspaceName,
  worktreeRoot: Schema.optional(AgentSessionFields.worktreeRoot),
  worktreePath: Schema.optional(AgentSessionFields.worktreePath),
  branch: Schema.optional(AgentSessionFields.branch),
  baseCommit: Schema.optional(AgentSessionFields.baseCommit),
  useWorktree: AgentSessionFields.useWorktree,
  setupHook: Schema.optional(AgentSessionFields.setupHook),
  cleanupHook: Schema.optional(AgentSessionFields.cleanupHook),
  setupOutputFile: Schema.optional(AgentSessionFields.setupOutputFile),
  cleanupOutputFile: Schema.optional(AgentSessionFields.cleanupOutputFile),
  backendSessionId: Schema.optional(AgentSessionFields.backendSessionId),
  setupRan: AgentSessionFields.setupRan,
  resuming: AgentSessionFields.resuming,
  baselineStatus: Schema.optional(AgentSessionFields.baselineStatus),
  lastExitStatus: Schema.optional(AgentSessionFields.lastExitStatus),
  executionId: Schema.optional(AgentSessionFields.executionId),
  executionPid: Schema.optional(AgentSessionFields.executionPid),
  executionStartedAt: Schema.optional(AgentSessionFields.executionStartedAt),
  executionOwnerPid: Schema.optional(AgentSessionFields.executionOwnerPid),
  executionOwnerStartedAt: Schema.optional(AgentSessionFields.executionOwnerStartedAt),
  lastActivityAt: AgentSessionFields.lastActivityAt,
});
export type AgentSessionRecord = (typeof agentSessionRecordSchema)["Type"];

export const tmuxSessionNameSchema = Schema.Trim.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);

export const publicKeyJwkSchema = struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: base64UrlValueSchema,
  y: base64UrlValueSchema,
});
export type PublicKeyJwk = (typeof publicKeyJwkSchema)["Type"];

export const pairingQrPayloadSchema = struct({
  v: Schema.Literal(2),
  muximodBaseUrl: httpUrlString,
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  pairingSecret: base64UrlValueSchema.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  expiresAt: Schema.Int.check(positiveInt),
});
export type PairingQrPayload = (typeof pairingQrPayloadSchema)["Type"];

export const pairingCodePayloadSchema = struct({
  muximodBaseUrl: httpUrlString,
  pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  pairingSecret: base64UrlValueSchema.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
});
export type PairingCodePayload = (typeof pairingCodePayloadSchema)["Type"];

const localAuthSessionResponseSchema = struct({
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  accessToken: base64UrlValueSchema.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  expiresAt: dateTimeString,
});

const pairingClaimNotificationFields = {
  pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  deviceName: displayValueSchema,
  deviceType: authDeviceTypeSchema,
  platform: Schema.NullOr(Schema.String),
  clientVersion: Schema.NullOr(Schema.String),
  keyFingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  expiresAt: dateTimeString,
} as const;

const pairingClaimNotificationSchema = struct(pairingClaimNotificationFields);
export type PairingClaimNotification = (typeof pairingClaimNotificationSchema)["Type"];

const agentSessionIdString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const executionIdString = Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(128));
const hostPaneIdString = Schema.String.check(Schema.isPattern(/^%[0-9]+$/));

const agentExecutionProcessResultSchema = struct({
  started: Schema.Boolean,
  code: Schema.Int,
  interrupted: Schema.Boolean,
  signal: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(32)))),
  failureDiagnostic: Schema.optional(boundedString(1, 4_096)),
  pid: Schema.optional(Schema.Int.check(positiveInt)),
});

export const muximodControlRequestSchema = discriminatedUnion("type", [
  unionCase("type", "create_local_session", {
    requestId: controlRequestIdSchema,
  }),
  unionCase("type", "create_pairing", {
    requestId: controlRequestIdSchema,
    muximodBaseUrl: httpUrlString,
  }),
  unionCase("type", "approve_pairing", {
    requestId: controlRequestIdSchema,
    pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  }),
  unionCase("type", "reject_pairing", {
    requestId: controlRequestIdSchema,
    pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  }),
  unionCase("type", "adopt_agent_session", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
  }),
  unionCase("type", "release_agent_session", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
  }),
  unionCase("type", "observe_agent_session", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
    state: paneStateSchema,
    recentOutput: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  }),
  unionCase("type", "read_log", {
    requestId: controlRequestIdSchema,
    lines: Schema.Int.check(intInRange(1, 10_000)),
  }),
  unionCase("type", "prepare_agent_execution", {
    requestId: controlRequestIdSchema,
    operation: Schema.Literal("run"),
    input: agentSessionStartInputSchema,
  }),
  unionCase("type", "prepare_agent_execution", {
    requestId: controlRequestIdSchema,
    operation: Schema.Literal("resume"),
    input: agentSessionResumeInputSchema,
  }),
  unionCase("type", "attach_agent_execution", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    executionId: executionIdString,
    hostPaneId: Schema.optional(hostPaneIdString),
    executionPid: Schema.Int.check(positiveInt),
    executionStartedAt: dateTimeString,
    executionOwnerPid: Schema.optional(Schema.Int.check(positiveInt)),
    executionOwnerStartedAt: Schema.optional(dateTimeString),
  }),
  unionCase("type", "complete_agent_execution", {
    requestId: controlRequestIdSchema,
    operation: Schema.Literals(["run", "resume"]),
    agentSessionId: agentSessionIdString,
    executionId: executionIdString,
    hostPaneId: Schema.optional(hostPaneIdString),
    result: agentExecutionProcessResultSchema,
  }),
]);
export type MuximodControlRequest = (typeof muximodControlRequestSchema)["Type"];

export type ControlFrameDecode<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid_json" | "invalid_shape"; message: string };

export function decodeMuximodControlRequest(data: string | Uint8Array): ControlFrameDecode<MuximodControlRequest> {
  return decodeControlFrame(data, muximodControlRequestSchema);
}

export function encodeMuximodControlRequest(request: MuximodControlRequest): string {
  return JSON.stringify(Schema.encodeSync(muximodControlRequestSchema)(request));
}

const cleanupReasonWireSchema = Schema.Literals([
  "cleanup_declined",
  "remote_archive_failed",
  "remote_restore_failed",
  "cleanup_hook_failed",
  "unregistered_worktree",
  "worktree_removal_failed",
]);
const cleanupResultWireSchema = discriminatedUnion("disposition", [
  unionCase("disposition", "removed", {}),
  unionCase("disposition", "retained", { reason: cleanupReasonWireSchema }),
  unionCase("disposition", "failed", { reason: cleanupReasonWireSchema }),
]);
const runCleanupResultWireSchema = discriminatedUnion("disposition", [
  unionCase("disposition", "not_requested", { reason: Schema.Literals(["interrupted", "no_worktree"]) }),
  unionCase("disposition", "removed", {}),
  unionCase("disposition", "retained", { reason: cleanupReasonWireSchema }),
  unionCase("disposition", "failed", { reason: cleanupReasonWireSchema }),
]);

export const muximodControlResponseSchema = discriminatedUnion("type", [
  unionCase("type", "local_session_created", {
    requestId: controlRequestIdSchema,
    session: localAuthSessionResponseSchema,
  }),
  unionCase("type", "pairing_created", {
    requestId: controlRequestIdSchema,
    pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
    pairingCode: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(8_192), Schema.isPattern(/^ma3:/)),
    payload: pairingQrPayloadSchema,
  }),
  unionCase("type", "pairing_claimed", {
    ...pairingClaimNotificationFields,
  }),
  unionCase("type", "pairing_result", {
    requestId: controlRequestIdSchema,
    pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
    status: Schema.Literals(["approved", "rejected"]),
    deviceId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  }),
  unionCase("type", "agent_session_adopted", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
  }),
  unionCase("type", "agent_session_released", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
  }),
  unionCase("type", "agent_session_observed", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    hostPaneId: hostPaneIdString,
    executionId: executionIdString,
    state: paneStateSchema,
  }),
  unionCase("type", "daemon_log", {
    requestId: controlRequestIdSchema,
    state: Schema.Literals(["available", "empty", "missing"]),
    logFile: Schema.String.check(Schema.isMinLength(1)),
    lines: Schema.Array(Schema.String).check(Schema.isMaxLength(10_000)),
  }),
  unionCase("type", "agent_execution_prepared", {
    requestId: controlRequestIdSchema,
    operation: Schema.Literals(["run", "resume"]),
    agentSessionId: agentSessionIdString,
    executionId: executionIdString,
    hostPaneId: Schema.optional(hostPaneIdString),
    session: agentSessionRecordSchema,
    execution: agentExecutionPlanSchema,
  }),
  unionCase("type", "agent_execution_attached", {
    requestId: controlRequestIdSchema,
    agentSessionId: agentSessionIdString,
    executionId: executionIdString,
    executionPid: Schema.Int.check(positiveInt),
    executionStartedAt: dateTimeString,
  }),
  unionCase("type", "agent_execution_completed", {
    requestId: controlRequestIdSchema,
    operation: Schema.Literals(["run", "resume"]),
    agentSessionId: agentSessionIdString,
    executionId: executionIdString,
    process: agentExecutionProcessResultSchema,
    session: agentSessionRecordSchema,
    cleanup: Schema.optional(runCleanupResultWireSchema),
  }),
  unionCase("type", "error", {
    requestId: Schema.optional(controlRequestIdSchema),
    code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
]);
export type MuximodControlResponse = (typeof muximodControlResponseSchema)["Type"];

export type MuximodControlLogResult = Pick<
  Extract<MuximodControlResponse, { type: "daemon_log" }>,
  "state" | "logFile" | "lines"
>;

export function decodeMuximodControlResponse(data: string | Uint8Array): ControlFrameDecode<MuximodControlResponse> {
  return decodeControlFrame(data, muximodControlResponseSchema);
}

export function encodeMuximodControlResponse(response: MuximodControlResponse): string {
  return JSON.stringify(Schema.encodeSync(muximodControlResponseSchema)(response));
}

export const authInfoSchema = struct({
  protocolVersion: Schema.Literal(protocolVersion),
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  serverTime: dateTimeString,
});
export type AuthInfo = (typeof authInfoSchema)["Type"];

export const pairingClaimRequestSchema = struct({
  pairingSecret: base64UrlValueSchema.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  publicKey: publicKeyJwkSchema,
  deviceName: displayValueSchema,
  deviceType: authDeviceTypeSchema,
  platform: Schema.optional(unboundedTrimmedString(120).check(Schema.isPattern(/^[^\u0000\r\n]*$/))),
  clientVersion: Schema.optional(unboundedTrimmedString(120).check(Schema.isPattern(/^[^\u0000\r\n]*$/))),
  clientNonce: base64UrlValueSchema.check(Schema.isMinLength(16), Schema.isMaxLength(512)),
  signature: base64UrlValueSchema.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type PairingClaimRequest = (typeof pairingClaimRequestSchema)["Type"];

export const pairingClaimResponseSchema = struct({
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  pairingId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  claimToken: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  status: Schema.Literal("awaiting_approval"),
  expiresAt: dateTimeString,
  keyFingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type PairingClaimResponse = (typeof pairingClaimResponseSchema)["Type"];

export const pairingStatusSchema = struct({
  status: Schema.Literals(["offered", "awaiting_approval", "approved", "rejected", "expired"]),
  deviceId: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
});
export type PairingStatus = (typeof pairingStatusSchema)["Type"];

export const authChallengeRequestSchema = struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type AuthChallengeRequest = (typeof authChallengeRequestSchema)["Type"];

export const authChallengeResponseSchema = struct({
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  challengeId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  nonce: base64UrlValueSchema.check(Schema.isMinLength(16), Schema.isMaxLength(512)),
  expiresAt: dateTimeString,
});
export type AuthChallengeResponse = (typeof authChallengeResponseSchema)["Type"];

export const authSessionRequestSchema = struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  challengeId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  signature: base64UrlValueSchema.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
});
export type AuthSessionRequest = (typeof authSessionRequestSchema)["Type"];

export const authSessionResponseSchema = struct({
  serverId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  sessionId: Schema.String.check(Schema.isMinLength(16), Schema.isMaxLength(256)),
  accessToken: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  expiresAt: dateTimeString,
});
export type AuthSessionResponse = (typeof authSessionResponseSchema)["Type"];

export const wsTicketRequestSchema = struct({
  endpoint: Schema.Literal("terminal"),
});
export type WsTicketRequest = (typeof wsTicketRequestSchema)["Type"];

export const wsTicketResponseSchema = struct({
  ticket: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(512)),
  endpoint: Schema.Literal("terminal"),
  expiresAt: dateTimeString,
});
export type WsTicketResponse = (typeof wsTicketResponseSchema)["Type"];

export const authDeviceSchema = struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  deviceType: authDeviceTypeSchema,
  platform: Schema.NullOr(Schema.String),
  clientVersion: Schema.NullOr(Schema.String),
  keyFingerprint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  status: Schema.Literals(["active", "revoked"]),
  createdAt: dateTimeString,
  lastSeenAt: Schema.NullOr(dateTimeString),
  revokedAt: Schema.NullOr(dateTimeString),
});
export type AuthDevice = (typeof authDeviceSchema)["Type"];

export const muximodEventSchema = struct({
  type: Schema.Literal("session_updated"),
  sessionName: Schema.String.check(Schema.isMinLength(1)),
  reason: Schema.Literals(["pane_created", "pane_deleted", "pane_changed"]),
  revision: Schema.Int.check(nonNegativeInt),
});
export type MuximodEvent = (typeof muximodEventSchema)["Type"];

export type { WorkspaceSelectionMode } from "@muximo/domain";
export { workspaceSelectionModeSchema };

const workspaceIdString = nonEmptyString;
const paneIdString = nonEmptyString;

export const workspaceDirectorySchema = struct({
  id: workspaceIdString,
  name: WorkspaceFields.name,
  directory: WorkspaceFields.rootPath,
  isGit: WorkspaceFields.isGit,
  setupScriptPath: Schema.NullOr(WorkspaceFields.setupScriptPath),
  cleanupScriptPath: Schema.NullOr(WorkspaceFields.cleanupScriptPath),
});
export type WorkspaceDirectory = (typeof workspaceDirectorySchema)["Type"];

export const workspaceListResponseSchema = struct({ workspaces: Schema.Array(workspaceDirectorySchema) });

export const workspaceBrowseResponseSchema = struct({ directories: Schema.Array(workspaceDirectorySchema) });

const workspaceHookPatchSchema = Schema.optional(
  Schema.NullOr(Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
);
const workspaceNameInputSchema = Schema.optional(
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(120), Schema.isPattern(/^[^\u0000\r\n\t]*$/)),
);

export const registerWorkspaceRequestSchema = struct({
  directory: boundedString(1, 4_096),
  name: workspaceNameInputSchema,
  setupScriptPath: workspaceHookPatchSchema,
  cleanupScriptPath: workspaceHookPatchSchema,
});
export type RegisterWorkspaceRequest = (typeof registerWorkspaceRequestSchema)["Type"];

export const updateWorkspaceRequestSchema = struct({
  name: workspaceNameInputSchema,
  setupScriptPath: workspaceHookPatchSchema,
  cleanupScriptPath: workspaceHookPatchSchema,
});
export type UpdateWorkspaceRequest = (typeof updateWorkspaceRequestSchema)["Type"];

export const workspaceResponseSchema = struct({ workspace: workspaceDirectorySchema });

export const workspaceSelectionSchema = struct({
  workspaceId: workspaceIdString,
  mode: workspaceSelectionModeSchema,
});
export type WorkspaceSelection = (typeof workspaceSelectionSchema)["Type"];

export const agentSessionWorkspaceScopeSchema = agentSessionWorkspaceScopeInputSchema;
export type AgentSessionWorkspaceScope = (typeof agentSessionWorkspaceScopeSchema)["Type"];

export const cleanupAgentSessionRequestSchema = struct({
  workspaceScope: agentSessionWorkspaceScopeSchema,
  force: Schema.Boolean,
  reference: boundedString(1, 256),
});
export type CleanupAgentSessionRequest = (typeof cleanupAgentSessionRequestSchema)["Type"];

export const listAgentSessionsRequestSchema = struct({
  workspaceScope: agentSessionWorkspaceScopeSchema,
  includeUnavailable: Schema.Boolean,
});
export type ListAgentSessionsRequest = (typeof listAgentSessionsRequestSchema)["Type"];

export const processResultSchema = struct({
  started: Schema.Boolean,
  code: Schema.Int,
  interrupted: Schema.Boolean,
  signal: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(32)))),
  failureDiagnostic: Schema.optional(boundedString(1, 4_096)),
});
export type ProcessResult = (typeof processResultSchema)["Type"];

export const cleanupReasonSchema = cleanupReasonWireSchema;
export type CleanupReason = (typeof cleanupReasonSchema)["Type"];

export const cleanupResultSchema = cleanupResultWireSchema;
export type CleanupResult = (typeof cleanupResultSchema)["Type"];

export const runCleanupResultSchema = runCleanupResultWireSchema;
export type RunCleanupResult = (typeof runCleanupResultSchema)["Type"];

export const agentSessionExecutionHealthSchema = Schema.Literals([
  "inactive",
  "active",
  "long_running",
  "stale",
  "unknown",
]);
export type AgentSessionExecutionHealth = (typeof agentSessionExecutionHealthSchema)["Type"];

export const agentSessionResumeStateSchema = Schema.Literals(["available", "unavailable", "unknown"]);
export type AgentSessionResumeState = (typeof agentSessionResumeStateSchema)["Type"];

export const agentSessionResumeReasonSchema = Schema.NullOr(
  Schema.Literals([
    "backend_session_missing",
    "backend_session_discovery_required",
    "currently_running",
    "execution_state_unknown",
    "not_resumable_state",
    "worktree_missing",
    "worktree_state_unknown",
    "worktree_unregistered",
  ]),
);
export type AgentSessionResumeReason = (typeof agentSessionResumeReasonSchema)["Type"];

export const agentSessionWorktreeStateSchema = Schema.Literals([
  "not_applicable",
  "available",
  "missing",
  "unregistered",
  "unknown",
]);
export type AgentSessionWorktreeState = (typeof agentSessionWorktreeStateSchema)["Type"];

export const agentSessionListProjectionSchema = struct({
  session: agentSessionRecordSchema,
  executionHealth: agentSessionExecutionHealthSchema,
  resume: agentSessionResumeStateSchema,
  resumeReason: agentSessionResumeReasonSchema,
  worktreeState: agentSessionWorktreeStateSchema,
  visibleByDefault: Schema.Boolean,
});
export type AgentSessionListProjection = (typeof agentSessionListProjectionSchema)["Type"];

export const agentSessionListResponseSchema = struct({
  allViews: Schema.Array(agentSessionListProjectionSchema),
  views: Schema.Array(agentSessionListProjectionSchema),
});
export type AgentSessionListResponse = (typeof agentSessionListResponseSchema)["Type"];

export const runAgentSessionResponseSchema = struct({
  process: processResultSchema,
  session: agentSessionRecordSchema,
  cleanup: runCleanupResultSchema,
});
export type RunAgentSessionResponse = (typeof runAgentSessionResponseSchema)["Type"];

export const resumeAgentSessionResponseSchema = struct({
  process: processResultSchema,
  session: agentSessionRecordSchema,
});
export type ResumeAgentSessionResponse = (typeof resumeAgentSessionResponseSchema)["Type"];

export const cleanupAgentSessionResponseSchema = struct({
  session: agentSessionRecordSchema,
  cleanup: cleanupResultSchema,
});
export type CleanupAgentSessionResponse = (typeof cleanupAgentSessionResponseSchema)["Type"];

const dimensionsFields = {
  cols: Schema.Int.check(intInRange(1, 500)),
  rows: Schema.Int.check(intInRange(1, 300)),
} as const;

const terminalFrameVersionFields = {
  version: Schema.Literal(terminalProtocolVersion),
} as const;

const terminalSessionIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const terminalResumeTokenSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const terminalOwnerSchema = Schema.Literals(["mobile", "desktop"]);

const terminalAttachBaseFields = {
  ...terminalFrameVersionFields,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ...dimensionsFields,
} as const;

export const clientControlMessageSchema = discriminatedUnion("type", [
  unionCase("type", "attach", {
    ...terminalAttachBaseFields,
  }),
  unionCase("type", "attach", {
    ...terminalAttachBaseFields,
    sessionId: terminalSessionIdSchema,
    resumeToken: terminalResumeTokenSchema,
  }),
  unionCase("type", "resize", {
    ...terminalFrameVersionFields,
    ...dimensionsFields,
  }),
  unionCase("type", "redraw", {
    ...terminalFrameVersionFields,
  }),
  unionCase("type", "ping", {
    ...terminalFrameVersionFields,
    nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  unionCase("type", "detach", {
    ...terminalFrameVersionFields,
    sessionId: Schema.optional(terminalSessionIdSchema),
  }),
  unionCase("type", "claim", {
    ...terminalFrameVersionFields,
    ...dimensionsFields,
  }),
  unionCase("type", "enter_copy_mode", {
    ...terminalFrameVersionFields,
  }),
  unionCase("type", "paste_tmux_buffer", {
    ...terminalFrameVersionFields,
  }),
  unionCase("type", "paste_image", {
    ...terminalFrameVersionFields,
    // Display name for the inline-image protocol and for tools that read the
    // pasted file. Kept on the client because the OS picker knows it.
    name: Schema.Trim.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(255),
      Schema.isPattern(/^[^\u0000-\u001f\u007f:;]+$/),
    ),
    mimeType: Schema.optional(
      Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(255), Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/)),
    ),
    // Standard base64 (with padding) so muximod can decode without URL handling.
    data: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
      Schema.isMinLength(1),
      Schema.isMaxLength(maxPasteImageBase64Length),
    ),
  }),
]);

export type ClientControlMessage = (typeof clientControlMessageSchema)["Type"];

export type TerminalControlFrameDecode<T> =
  | { ok: true; message: T }
  | { ok: false; code: "invalid_json" | "unsupported_version" | "invalid_message"; message: string };

export type ClientControlFrameDecode = TerminalControlFrameDecode<ClientControlMessage>;

/** Validates and encodes a client control message for a text WebSocket frame. */
export function encodeClientControlFrame(message: ClientControlMessage): string {
  return JSON.stringify(Schema.encodeSync(clientControlMessageSchema)(message));
}

/** Decodes and validates a text WebSocket control frame at the protocol boundary. */
export function decodeClientControlFrame(data: string | Uint8Array): ClientControlFrameDecode {
  return decodeTerminalControlFrame(data, clientControlMessageSchema);
}

export const paneSummarySchema = struct({
  id: paneIdString,
  hostPaneId: Schema.String.check(Schema.isPattern(/^%[0-9]+$/)),
  sessionName: PaneFields.sessionName,
  windowId: PaneFields.windowId,
  kind: paneKindSchema,
  name: PaneFields.name,
  cwd: PaneFields.cwd,
  workspaceId: Schema.NullOr(paneIdString),
  agentId: Schema.NullOr(PaneFields.agentId),
  state: paneStateSchema,
  title: Schema.NullOr(PaneFields.title),
  // Live-only output tail. It is intentionally bounded and omitted from
  // persisted pane rows so the pane list remains a small status projection.
  recentOutput: Schema.optional(PaneFields.recentOutput.check(Schema.isMaxLength(2_000))),
  lastSeenAt: PaneFields.lastSeenAt,
  // Live tmux geometry used by the pane layout.
  windowName: Schema.optional(PaneFields.windowName),
  windowIndex: Schema.optional(PaneFields.windowIndex),
  // Pane indexes are scoped to a tmux window and are distinct from hostPaneId
  // (the server-wide target such as %32).
  paneIndex: Schema.optional(PaneFields.paneIndex),
  left: Schema.optional(PaneFields.left),
  top: Schema.optional(PaneFields.top),
  width: Schema.optional(PaneFields.width),
  height: Schema.optional(PaneFields.height),
  windowWidth: Schema.optional(PaneFields.windowWidth),
  windowHeight: Schema.optional(PaneFields.windowHeight),
});

export const paneListResponseSchema = struct({ panes: Schema.Array(paneSummarySchema) });
export type PaneSummary = (typeof paneSummarySchema)["Type"];

export const panePlacementSchema = Schema.Literals(["window", "right", "bottom"]);
export type PanePlacement = (typeof panePlacementSchema)["Type"];

export const createPaneRequestSchema = wire(
  Schema.Struct({
    sessionName: tmuxSessionNameSchema,
    kind: Schema.Literals(["agent", "shell"]),
    name: Schema.Trim.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(120),
      Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
    ),
    workspaceId: Schema.optional(workspaceIdString),
    agentId: Schema.NullOr(agentBackendSchema),
    useWorktree: Schema.Boolean,
    placement: panePlacementSchema,
    targetPaneId: Schema.NullOr(boundedString(1, 64)),
  }).check(
    Schema.makeFilter((value) => {
      const issues: Array<Schema.FilterIssue> = [];
      if (value.placement !== "window" && value.workspaceId && !value.useWorktree) {
        issues.push({ path: ["workspaceId"], issue: "workspaceId on a split pane requires useWorktree" });
      }
      if (value.kind === "agent" && !value.agentId) {
        issues.push({ path: ["agentId"], issue: "agentId is required for an agent pane" });
      }
      if (value.kind === "shell" && value.agentId) {
        issues.push({ path: ["agentId"], issue: "agentId is not allowed for a shell pane" });
      }
      if (value.placement === "window" && value.targetPaneId) {
        issues.push({ path: ["targetPaneId"], issue: "targetPaneId is only used for a split pane" });
      }
      if (value.placement !== "window" && !value.targetPaneId) {
        issues.push({ path: ["targetPaneId"], issue: "targetPaneId is required for a split pane" });
      }
      return issues;
    }),
  ),
);
export type CreatePaneRequest = (typeof createPaneRequestSchema)["Type"];

export const paneResponseSchema = struct({ pane: paneSummarySchema });

export const terminalEndpointSchema = struct({
  id: nonEmptyString,
  name: nonEmptyString,
  host: nonEmptyString,
  tailnetIp: nonEmptyString,
  state: Schema.Literals(["online", "offline"]),
  detail: Schema.String,
  lastSeen: Schema.String,
});
export type TerminalEndpoint = (typeof terminalEndpointSchema)["Type"];

export const terminalListResponseSchema = struct({ terminals: Schema.Array(terminalEndpointSchema) });

export const tmuxSessionSchema = struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  paneCount: Schema.Int.check(nonNegativeInt),
  waitingCount: Schema.Int.check(nonNegativeInt),
  detail: Schema.String,
  managed: Schema.Boolean,
});
export type TmuxSession = (typeof tmuxSessionSchema)["Type"];

export const sessionListResponseSchema = struct({ sessions: Schema.Array(tmuxSessionSchema) });

export const manageSessionRequestSchema = struct({
  name: tmuxSessionNameSchema,
});
export type ManageSessionRequest = (typeof manageSessionRequestSchema)["Type"];

export const managedSessionResponseSchema = struct({
  session: struct({
    name: Schema.String.check(Schema.isMinLength(1)),
    changed: Schema.Boolean,
  }),
});
export type ManagedSessionResponse = (typeof managedSessionResponseSchema)["Type"];

export const createSessionRequestSchema = struct({
  name: tmuxSessionNameSchema,
  workspaceId: workspaceIdString,
});
export type CreateSessionRequest = (typeof createSessionRequestSchema)["Type"];

export const sessionResponseSchema = struct({ session: tmuxSessionSchema });

export const serverControlMessageSchema = discriminatedUnion("type", [
  unionCase("type", "ready", {
    ...terminalFrameVersionFields,
    sessionId: terminalSessionIdSchema,
    resumeToken: terminalResumeTokenSchema,
    resumed: Schema.Boolean,
    target: Schema.String,
    paneId: Schema.String,
    windowId: Schema.String,
    owner: terminalOwnerSchema,
    sync: Schema.Literals(["live", "replay", "redraw"]),
    ...dimensionsFields,
  }),
  unionCase("type", "viewport", {
    ...terminalFrameVersionFields,
    owner: terminalOwnerSchema,
    reason: Schema.Literals([
      "attached",
      "mobile_claim",
      "desktop_activity",
      "desktop_resize",
      "desktop_focus",
      "detached",
    ]),
  }),
  unionCase("type", "pong", {
    ...terminalFrameVersionFields,
    nonce: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  }),
  unionCase("type", "error", {
    ...terminalFrameVersionFields,
    sessionId: Schema.optional(terminalSessionIdSchema),
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.optional(Schema.Boolean),
  }),
  unionCase("type", "closed", {
    ...terminalFrameVersionFields,
    sessionId: terminalSessionIdSchema,
    reason: Schema.Literals(["detached", "terminal_exit", "network_timeout", "server_shutdown"]),
    code: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
  }),
]);

export type ServerControlMessage = (typeof serverControlMessageSchema)["Type"];

export type ServerControlFrameDecode = TerminalControlFrameDecode<ServerControlMessage>;

/** Decodes and validates a text WebSocket control frame at the protocol boundary. */
export function decodeServerControlFrame(data: string | Uint8Array): ServerControlFrameDecode {
  return decodeTerminalControlFrame(data, serverControlMessageSchema);
}

/** Validates and encodes a server control message for a text WebSocket frame. */
export function encodeServerControlFrame(message: ServerControlMessage): string {
  return JSON.stringify(Schema.encodeSync(serverControlMessageSchema)(message));
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
  schema: Schema.ConstraintDecoder<unknown>,
): ControlFrameDecode<T> {
  let input: unknown;
  try {
    input = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as unknown;
  } catch {
    return { ok: false, code: "invalid_json", message: "control frame must be valid JSON" };
  }

  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
  return Result.isFailure(result)
    ? { ok: false, code: "invalid_shape", message: "control frame has an invalid shape" }
    : { ok: true, value: result.success as T };
}

function decodeTerminalControlFrame<T>(
  data: string | Uint8Array,
  schema: Schema.ConstraintDecoder<unknown>,
): TerminalControlFrameDecode<T> {
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

  const result = Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })(input);
  return Result.isFailure(result)
    ? { ok: false, code: "invalid_message", message: "control frame message failed validation" }
    : { ok: true, message: result.success as T };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export * from "./auth-crypto.js";
