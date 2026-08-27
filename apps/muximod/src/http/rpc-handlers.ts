import type {
  AuthPairingClaimRequest as ApplicationAuthPairingClaimRequest,
  CreatePaneInput,
  CreateSessionInput,
  ManageSessionInput,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
  MuximodWorkspaceDirectory,
  RegisterWorkspaceCommand,
  UpdateWorkspaceCommand,
} from "@muximo/application";
import {
  authInfoSchema,
  type CreatePaneRequest,
  type CreateSessionRequest,
  type ManageSessionRequest,
  muximodCapabilitiesSchema,
  muximodContract,
  type pairingClaimRequestSchema,
  pairingStatusSchema,
  paneSummarySchema,
  protocolVersion,
  type RegisterWorkspaceRequest,
  type UpdateWorkspaceRequest,
} from "@muximo/contract";
import { clearPatch, type Patch } from "@muximo/domain";
import { implement, ORPCError } from "@orpc/server";
import type { z } from "zod";
import { presentMuximodHealth } from "./health.js";
import { MuximodHttpError, mapError } from "./middleware.js";
import type { MuximodAuthContext as HttpAuthContext, MuximodHttpDependencies, MuximodHttpStatus } from "./types.js";

export type MuximodRpcContext = {
  auth: HttpAuthContext | undefined;
  pairingToken?: string;
};

export async function contextForRequest(request: Request, deps: MuximodHttpDependencies): Promise<MuximodRpcContext> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
  return {
    auth: await deps.auth.authenticateAccessToken(token || undefined),
    pairingToken: request.headers.get("x-muximod-pairing-token") ?? undefined,
  };
}

export function requireAuth(context: MuximodRpcContext): HttpAuthContext {
  if (!context.auth) throw new ORPCError("UNAUTHORIZED", { message: "Bearer authentication is required" });
  return context.auth;
}

function safeCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toRpcError(error);
  }
}

async function safeAsyncCall<T>(operation: () => Promise<T>, context?: MuximodRpcContext): Promise<T> {
  try {
    if (context) requireAuth(context);
    return await operation();
  } catch (error) {
    throw toRpcError(error);
  }
}

function toRpcError(error: unknown): ORPCError<string, { code: string; details?: Record<string, unknown> }> {
  if (error instanceof ORPCError)
    return error as ORPCError<string, { code: string; details?: Record<string, unknown> }>;
  const mapped = mapError(error);
  return new ORPCError(rpcCode(mapped.status), {
    message: mapped.message,
    data: { code: mapped.code, ...(mapped.details ? { details: mapped.details } : {}) },
  });
}

function rpcCode(
  status: MuximodHttpStatus,
):
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "SERVICE_UNAVAILABLE" {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "TOO_MANY_REQUESTS";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  return "BAD_REQUEST";
}

function toApplicationCreatePane(input: CreatePaneRequest): CreatePaneInput {
  return {
    sessionName: input.sessionName,
    kind: input.kind,
    name: input.name,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    agentId: input.agentId,
    useWorktree: input.useWorktree,
    placement: input.placement,
    targetPaneId: input.targetPaneId,
  };
}

function toApplicationCreateSession(input: CreateSessionRequest): CreateSessionInput {
  return {
    name: input.name,
    workspaceId: input.workspaceId,
  };
}

function toApplicationManageSession(input: ManageSessionRequest): ManageSessionInput {
  return { name: input.name };
}

function toApplicationPairingClaim(
  input: z.infer<typeof pairingClaimRequestSchema>,
): ApplicationAuthPairingClaimRequest {
  return {
    pairingSecret: input.pairingSecret,
    publicKey: input.publicKey,
    deviceName: input.deviceName,
    deviceType: input.deviceType,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
    clientNonce: input.clientNonce,
    signature: input.signature,
  };
}

function toApplicationRegisterWorkspace(input: RegisterWorkspaceRequest): RegisterWorkspaceCommand {
  return {
    directory: input.directory,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.setupScriptPath === undefined ? {} : { setupScriptPath: toApplicationPatch(input.setupScriptPath) }),
    ...(input.cleanupScriptPath === undefined
      ? {}
      : { cleanupScriptPath: toApplicationPatch(input.cleanupScriptPath) }),
    ...(input.worktreeCopyPatterns === undefined ? {} : { worktreeCopyPatterns: input.worktreeCopyPatterns }),
  };
}

function toApplicationUpdateWorkspace(input: UpdateWorkspaceRequest): UpdateWorkspaceCommand {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.setupScriptPath === undefined ? {} : { setupScriptPath: toApplicationPatch(input.setupScriptPath) }),
    ...(input.cleanupScriptPath === undefined
      ? {}
      : { cleanupScriptPath: toApplicationPatch(input.cleanupScriptPath) }),
    ...(input.worktreeCopyPatterns === undefined ? {} : { worktreeCopyPatterns: input.worktreeCopyPatterns }),
    ...(input.appendWorktreeCopyPatterns === undefined
      ? {}
      : { appendWorktreeCopyPatterns: input.appendWorktreeCopyPatterns }),
    ...(input.clearWorktreeCopyPatterns === undefined
      ? {}
      : { clearWorktreeCopyPatterns: input.clearWorktreeCopyPatterns }),
  };
}

function toProtocolWorkspaceDirectory(value: MuximodWorkspaceDirectory) {
  return { ...value };
}

function toProtocolTerminal(value: MuximodTerminalEndpoint) {
  return { ...value };
}

function toProtocolSession(value: MuximodSessionSummary) {
  return { ...value };
}

function toProtocolPane(value: MuximodPaneSummary) {
  return paneSummarySchema.parse({
    id: value.id,
    hostPaneId: value.hostPaneId,
    sessionName: value.sessionName,
    windowId: value.windowId,
    kind: value.kind,
    name: value.name,
    cwd: value.cwd,
    workspaceId: value.workspaceId ?? null,
    agentId: value.agentId ?? null,
    state: value.state,
    title: value.title ?? null,
    ...(value.recentOutput === undefined ? {} : { recentOutput: value.recentOutput }),
    lastSeenAt: value.lastSeenAt,
    ...(value.windowName === undefined ? {} : { windowName: value.windowName }),
    ...(value.windowIndex === undefined ? {} : { windowIndex: value.windowIndex }),
    ...(value.paneIndex === undefined ? {} : { paneIndex: value.paneIndex }),
    ...(value.left === undefined ? {} : { left: value.left }),
    ...(value.top === undefined ? {} : { top: value.top }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.windowWidth === undefined ? {} : { windowWidth: value.windowWidth }),
    ...(value.windowHeight === undefined ? {} : { windowHeight: value.windowHeight }),
  });
}

function toApplicationPatch(value: string | null | undefined): Patch<string> {
  return value === null ? clearPatch : value;
}

async function* emptyEvents(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}

/** Binds every contract procedure to its application use case call. */
export function createMuximodRouter(deps: MuximodHttpDependencies) {
  const os = implement(muximodContract).$context<MuximodRpcContext>();

  return os.router({
    health: os.health.handler(() =>
      safeCall(() => {
        const health = presentMuximodHealth(deps.isReady?.() ?? true);
        if (!health.ready) throw new MuximodHttpError(health.status, health.body.error, health.body.message);
        return health.body;
      }),
    ),
    capabilities: os.capabilities.handler(({ context }) => {
      requireAuth(context);
      return muximodCapabilitiesSchema.parse({
        protocolVersion,
        features: {
          tmuxSessions: true,
          terminalWebSocket: true,
          paneState: true,
          resourceInvalidationEvents: true,
        },
      });
    }),
    auth: {
      info: os.auth.info.handler(() =>
        authInfoSchema.parse({
          protocolVersion,
          serverId: deps.auth.serverId,
          serverTime: new Date().toISOString(),
        }),
      ),
      claimPairing: os.auth.claimPairing.handler(({ input }) =>
        safeAsyncCall(() => deps.auth.claimPairing(input.pairingId, toApplicationPairingClaim(input.request))),
      ),
      pairingStatus: os.auth.pairingStatus.handler(({ input, context }) =>
        safeAsyncCall(async () => {
          const claimToken = context.pairingToken;
          if (!claimToken) throw new MuximodHttpError(401, "claim_token_required", "Pairing authorization is required");
          const status = await deps.auth.pairingStatus(input.pairingId, claimToken);
          return pairingStatusSchema.parse({ status: status.status, deviceId: status.deviceId ?? null });
        }),
      ),
      createChallenge: os.auth.createChallenge.handler(({ input }) =>
        safeAsyncCall(() => deps.auth.createChallenge(input.deviceId)),
      ),
      createSession: os.auth.createSession.handler(({ input }) =>
        safeAsyncCall(() =>
          deps.auth.createSession({
            deviceId: input.deviceId,
            challengeId: input.challengeId,
            signature: input.signature,
          }),
        ),
      ),
      issueWebSocketTicket: os.auth.issueWebSocketTicket.handler(({ input, context }) =>
        safeAsyncCall(() => deps.auth.issueWebSocketTicket(requireAuth(context), input.endpoint)),
      ),
    },
    workspaces: {
      list: os.workspaces.list.handler(({ context }) =>
        safeAsyncCall(
          async () => ({
            workspaces: (await deps.application.workspaces.list()).map(toProtocolWorkspaceDirectory),
          }),
          context,
        ),
      ),
      browse: os.workspaces.browse.handler(({ input, context }) =>
        safeAsyncCall(
          async () => ({
            directories: (await deps.application.workspaces.browse(input.path)).map(toProtocolWorkspaceDirectory),
          }),
          context,
        ),
      ),
      register: os.workspaces.register.handler(({ input, context }) =>
        safeAsyncCall(
          async () => ({
            workspace: toProtocolWorkspaceDirectory(
              await deps.application.workspaces.register(toApplicationRegisterWorkspace(input)),
            ),
          }),
          context,
        ),
      ),
      update: os.workspaces.update.handler(({ input, context }) =>
        safeAsyncCall(
          async () => ({
            workspace: toProtocolWorkspaceDirectory(
              await deps.application.workspaces.update(input.workspaceId, toApplicationUpdateWorkspace(input.input)),
            ),
          }),
          context,
        ),
      ),
      delete: os.workspaces.delete.handler(({ input, context }) =>
        safeAsyncCall(async () => {
          await deps.application.workspaces.delete(input.workspaceId);
          return {};
        }, context),
      ),
    },
    terminals: {
      list: os.terminals.list.handler(({ context }) =>
        safeAsyncCall(
          async () => ({
            terminals: [toProtocolTerminal(await deps.application.terminal.get())],
          }),
          context,
        ),
      ),
    },
    sessions: {
      list: os.sessions.list.handler(({ context }) =>
        safeAsyncCall(
          async () => ({
            sessions: (await deps.application.sessions.list()).map(toProtocolSession),
          }),
          context,
        ),
      ),
      create: os.sessions.create.handler(({ input, context }) =>
        safeAsyncCall(async () => {
          const session = await deps.application.sessions.create(toApplicationCreateSession(input));
          return { session: toProtocolSession(session) };
        }, context),
      ),
      manage: os.sessions.manage.handler(({ input, context }) =>
        safeAsyncCall(
          async () => ({ session: await deps.application.sessions.manage(toApplicationManageSession(input)) }),
          context,
        ),
      ),
    },
    panes: {
      list: os.panes.list.handler(({ input, context }) =>
        safeAsyncCall(
          async () => ({
            panes: (await deps.application.panes.list(input.session)).map(toProtocolPane),
          }),
          context,
        ),
      ),
      create: os.panes.create.handler(({ input, context }) =>
        safeAsyncCall(async () => {
          return {
            pane: toProtocolPane(await deps.application.panes.create(toApplicationCreatePane(input))),
          };
        }, context),
      ),
    },
    events: {
      subscribe: os.events.subscribe.handler(({ signal, context }) => {
        requireAuth(context);
        if (!deps.subscribeEvents) return emptyEvents();
        return deps.subscribeEvents(signal ?? new AbortController().signal);
      }),
    },
  });
}
