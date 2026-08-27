import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type {
  AgentSessionListResponse,
  CleanupAgentSessionRequest,
  CleanupAgentSessionResponse,
  ListAgentSessionsRequest,
  muximodContract,
  RegisterWorkspaceRequest,
  ResumeAgentSessionRequest,
  ResumeAgentSessionResponse,
  RunAgentSessionRequest,
  RunAgentSessionResponse,
  UpdateWorkspaceRequest,
  WorkspaceDirectory,
} from "@muximo/contract/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { MuximodPairingControlAdapter } from "./muximod-pairing-control-adapter.js";

type RpcClient = ContractRouterClient<typeof muximodContract>;

export type MuximodApiClient = {
  agentSessions: {
    run(input: RunAgentSessionRequest): Promise<RunAgentSessionResponse>;
    resume(input: ResumeAgentSessionRequest): Promise<ResumeAgentSessionResponse>;
    cleanup(input: CleanupAgentSessionRequest): Promise<CleanupAgentSessionResponse>;
    list(input: ListAgentSessionsRequest): Promise<AgentSessionListResponse>;
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
};

/** Opens the API with a short-lived token minted through the private socket. */
export async function connectMuximodApi(options: MuximodApiConnectionOptions): Promise<MuximodApiClient> {
  const control = await MuximodPairingControlAdapter.connect(options.controlSocket);
  try {
    const session = await control.createLocalSession();
    const rpc = createORPCClient<RpcClient>(
      new RPCLink({
        url: `${options.httpBaseUrl.replace(/\/$/u, "")}/rpc`,
        headers: async () => ({ authorization: `Bearer ${session.accessToken}` }),
      }),
    );
    return {
      agentSessions: {
        run: (input) => rpc.agentSessions.run(input),
        resume: (input) => rpc.agentSessions.resume(input),
        cleanup: (input) => rpc.agentSessions.cleanup(input),
        list: (input) => rpc.agentSessions.list(input),
      },
      workspaces: {
        list: async () => (await rpc.workspaces.list({})).workspaces,
        register: async (input) => (await rpc.workspaces.register(input)).workspace,
        update: async (selector, input) => {
          const workspace = await resolveWorkspaceSelector(rpc, selector, options.cwd);
          return (await rpc.workspaces.update({ workspaceId: workspace.id, input })).workspace;
        },
        delete: async (selector) => {
          const workspace = await resolveWorkspaceSelector(rpc, selector, options.cwd);
          await rpc.workspaces.delete({ workspaceId: workspace.id });
          return workspace;
        },
      },
    };
  } finally {
    control.close();
  }
}

async function resolveWorkspaceSelector(
  rpc: RpcClient,
  selector: string,
  cwd = process.cwd(),
): Promise<WorkspaceDirectory> {
  const workspaces = (await rpc.workspaces.list({})).workspaces;
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
