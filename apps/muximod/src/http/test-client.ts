import type { muximodContract } from "@muximo/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

type TestConnection = {
  httpBaseUrl: string;
  origin?: string;
  auth?: { getAccessToken: () => Promise<string> };
};

type RpcClient = ContractRouterClient<typeof muximodContract>;

export function createHttpTestClient(connection: TestConnection) {
  const rpc = createORPCClient<RpcClient>(
    new RPCLink({
      url: `${connection.httpBaseUrl.replace(/\/$/, "")}/rpc`,
      headers: async () => ({
        ...(connection.origin ? { origin: connection.origin } : {}),
        ...(connection.auth ? { authorization: `Bearer ${await connection.auth.getAccessToken()}` } : {}),
      }),
    }),
  );

  return {
    authInfo: () => rpc.auth.info({}),
    capabilities: () => rpc.capabilities({}),
    sessions: async () => (await rpc.sessions.list({})).sessions,
    panes: async (session?: string) => (await rpc.panes.list({ session })).panes,
    createSession: (input: Parameters<RpcClient["sessions"]["create"]>[0]) => rpc.sessions.create(input),
    manageSession: (input: Parameters<RpcClient["sessions"]["manage"]>[0]) => rpc.sessions.manage(input),
    createPane: (input: Parameters<RpcClient["panes"]["create"]>[0]) => rpc.panes.create(input),
    openEvents: () => rpc.events.subscribe({}),
  };
}
