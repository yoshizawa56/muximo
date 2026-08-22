import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { muximodContract } from "@muximo/contract";

type TestConnection = {
  httpBaseUrl: string;
  auth?: { getAccessToken: () => Promise<string> };
};

type RpcClient = ContractRouterClient<typeof muximodContract>;

export function createHttpTestClient(connection: TestConnection) {
  const rpc = createORPCClient<RpcClient>(new RPCLink({
    url: `${connection.httpBaseUrl.replace(/\/$/, "")}/rpc`,
    headers: async () => connection.auth ? { authorization: `Bearer ${await connection.auth.getAccessToken()}` } : {},
  }));

  return {
    authInfo: () => rpc.auth.info({}),
    capabilities: () => rpc.capabilities({}),
    sessions: async () => (await rpc.sessions.list({})).sessions,
    openEvents: () => rpc.events.subscribe({}),
  };
}
