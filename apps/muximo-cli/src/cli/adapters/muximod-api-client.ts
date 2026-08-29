import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { ManageSessionResult } from "@muximo/application";
import type {
  AgentSessionListResponse,
  AuthSessionResponse,
  CleanupAgentSessionRequest,
  CleanupAgentSessionResponse,
  ListAgentSessionsRequest,
  ManageSessionRequest,
  muximodContract,
  RegisterWorkspaceRequest,
  ResumeAgentSessionRequest,
  ResumeAgentSessionResponse,
  RunAgentSessionRequest,
  RunAgentSessionResponse,
  UpdateWorkspaceRequest,
  WorkspaceDirectory,
} from "@muximo/contract/api";
import type { MuximodControlLogResult } from "@muximo/contract/control";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { MuximodPairingControlAdapter } from "./muximod-pairing-control-adapter.js";

type RpcClient = ContractRouterClient<typeof muximodContract>;

export type MuximodApiClient = {
  sessions: {
    manage(input: ManageSessionRequest): Promise<ManageSessionResult>;
  };
  agentSessions: {
    run(input: RunAgentSessionRequest): Promise<RunAgentSessionResponse>;
    resume(input: ResumeAgentSessionRequest): Promise<ResumeAgentSessionResponse>;
    cleanup(input: CleanupAgentSessionRequest): Promise<CleanupAgentSessionResponse>;
    list(input: ListAgentSessionsRequest): Promise<AgentSessionListResponse>;
  };
  daemon: {
    readLog(lines: number): Promise<MuximodControlLogResult>;
  };
  workspaces: {
    list(): Promise<readonly WorkspaceDirectory[]>;
    register(input: RegisterWorkspaceRequest): Promise<WorkspaceDirectory>;
    update(selector: string, input: UpdateWorkspaceRequest): Promise<WorkspaceDirectory>;
    delete(selector: string): Promise<WorkspaceDirectory>;
  };
};

export type MuximodApiConnectionOptions = {
  httpBaseUrl: string;
  controlSocket: string;
  cwd?: string;
  ensureDaemon?: () => Promise<void>;
  resolveHttpBaseUrl?: () => string | Promise<string>;
};

export type MuximodDaemonLogOptions = {
  controlSocket: string;
  lines: number;
};

/** Opens the API with a short-lived token minted through the private socket. */
export async function connectMuximodApi(options: MuximodApiConnectionOptions): Promise<MuximodApiClient> {
  let session = await mintLocalSessionWithRecovery(options);
  let refreshPromise: Promise<void> | undefined;
  const refreshSession = async (force: boolean): Promise<void> => {
    if (!force && !sessionNeedsRefresh(session)) return;
    if (refreshPromise) return refreshPromise;
    refreshPromise = mintLocalSessionWithRecovery(options)
      .then((next) => {
        session = next;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  };
  const createRpc = (httpBaseUrl: string): RpcClient =>
    createORPCClient<RpcClient>(
      new RPCLink({
        url: `${httpBaseUrl.replace(/\/$/u, "")}/rpc`,
        headers: async () => {
          await refreshSession(false);
          return { authorization: `Bearer ${session.accessToken}` };
        },
      }),
    );
  let rpc = createRpc(options.httpBaseUrl);
  const request = async <Result>(operation: () => Promise<Result>, retryConnection = false): Promise<Result> => {
    await refreshSession(false);
    try {
      return await operation();
    } catch (error) {
      const unauthorized = isUnauthorizedError(error);
      const reconnectable = retryConnection && isConnectionError(error);
      if (!unauthorized && !reconnectable) throw error;
      if ((unauthorized || reconnectable) && options.ensureDaemon) await options.ensureDaemon();
      if (options.resolveHttpBaseUrl) rpc = createRpc(await options.resolveHttpBaseUrl());
      await refreshSession(true);
      return operation();
    }
  };
  const listWorkspaces = () => request(() => rpc.workspaces.list({}), true);
  return {
    sessions: {
      manage: async (input) => (await request(() => rpc.sessions.manage(input))).session,
    },
    agentSessions: {
      run: (input) => request(() => rpc.agentSessions.run(input)),
      resume: (input) => request(() => rpc.agentSessions.resume(input)),
      cleanup: (input) => request(() => rpc.agentSessions.cleanup(input)),
      list: (input) => request(() => rpc.agentSessions.list(input), true),
    },
    workspaces: {
      list: async () => (await listWorkspaces()).workspaces,
      register: async (input) => (await request(() => rpc.workspaces.register(input))).workspace,
      update: async (selector, input) => {
        const workspace = await resolveWorkspaceSelector(listWorkspaces, selector, options.cwd);
        return (await request(() => rpc.workspaces.update({ workspaceId: workspace.id, input }))).workspace;
      },
      delete: async (selector) => {
        const workspace = await resolveWorkspaceSelector(listWorkspaces, selector, options.cwd);
        await request(() => rpc.workspaces.delete({ workspaceId: workspace.id }));
        return workspace;
      },
    },
    daemon: {
      readLog: (lines) => readMuximodDaemonLog({ controlSocket: options.controlSocket, lines }),
    },
  };
}

/** Reads daemon diagnostics through the private contract without starting a daemon or requiring HTTP health. */
export async function readMuximodDaemonLog(options: MuximodDaemonLogOptions): Promise<MuximodControlLogResult> {
  return readDaemonLogThroughControl(options.controlSocket, options.lines);
}

async function mintLocalSession(socketPath: string): Promise<AuthSessionResponse> {
  const control = await MuximodPairingControlAdapter.connect(socketPath);
  try {
    return await control.createLocalSession();
  } finally {
    control.close();
  }
}

async function mintLocalSessionWithRecovery(options: MuximodApiConnectionOptions): Promise<AuthSessionResponse> {
  try {
    return await mintLocalSession(options.controlSocket);
  } catch (error) {
    if (!options.ensureDaemon || !isConnectionError(error)) throw error;
    await options.ensureDaemon();
    return mintLocalSession(options.controlSocket);
  }
}

async function readDaemonLogThroughControl(socketPath: string, lines: number): Promise<MuximodControlLogResult> {
  const control = await MuximodPairingControlAdapter.connect(socketPath);
  try {
    return await control.readLog(lines);
  } finally {
    control.close();
  }
}

function sessionNeedsRefresh(session: AuthSessionResponse): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000;
}

function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  return (
    value.status === 401 ||
    value.code === "UNAUTHORIZED" ||
    (typeof value.message === "string" && /(?:\b401\b|unauthorized)/iu.test(value.message))
  );
}

function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (
    value.code === "ECONNREFUSED" ||
    value.code === "ECONNRESET" ||
    value.code === "EPIPE" ||
    value.code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return true;
  }
  if (
    value.code === "control_socket_missing" ||
    value.code === "control_socket_connect_failed" ||
    value.code === "control_socket_closed" ||
    value.code === "control_socket_error"
  ) {
    return true;
  }
  if (value.cause && isConnectionError(value.cause)) return true;
  return typeof value.message === "string" && /fetch failed|connection refused|socket closed/iu.test(value.message);
}

async function resolveWorkspaceSelector(
  listWorkspaces: () => Promise<{ workspaces: WorkspaceDirectory[] }>,
  selector: string,
  cwd = process.cwd(),
): Promise<WorkspaceDirectory> {
  const workspaces = (await listWorkspaces()).workspaces;
  const exactId = workspaces.find((workspace) => workspace.id === selector);
  if (exactId) return exactId;

  const matches = workspaces.filter(
    (workspace) => workspace.name === selector || sameWorkspaceDirectory(workspace, selector, cwd),
  );
  if (matches.length === 1) {
    const [match] = matches;
    if (match) return match;
  }
  if (matches.length > 1) throw new Error(`workspace name is ambiguous; use its ID: ${selector}`);
  throw new Error(`workspace not found: ${selector}`);
}

function sameWorkspaceDirectory(workspace: WorkspaceDirectory, selector: string, cwd: string): boolean {
  return normalizeWorkspaceDirectory(workspace.directory, cwd) === normalizeWorkspaceDirectory(selector, cwd);
}

function normalizeWorkspaceDirectory(value: string, cwd: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
  return normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}
