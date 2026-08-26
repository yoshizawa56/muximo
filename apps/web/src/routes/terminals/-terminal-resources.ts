import type { TerminalEndpoint, TmuxSession } from "@muximo/contract";
import { useQuery } from "@tanstack/react-query";
import { useMuximodEvents } from "../../app/api/muximod-events";
import type { MuximodQueryUtils } from "../../app/api/orpc-utils";
import { useMuximodConnection } from "../../app/api/use-muximod-connection";

type ResourceStatus = "loading" | "ready" | "error" | undefined;

export type TerminalResources = {
  connection: ReturnType<typeof useMuximodConnection>["connection"];
  connectionKey: string;
  utils: MuximodQueryUtils;
  terminals: TerminalEndpoint[];
  sessions: TmuxSession[];
  selectedTerminal: TerminalEndpoint | null;
  selectedSession: TmuxSession | null;
  terminalsStatus: ResourceStatus;
  terminalsError: string | null;
  sessionsStatus: ResourceStatus;
  sessionsError: string | null;
};

export function useTerminalResources({
  terminalId,
  sessionName,
  pollSessions = false,
}: {
  terminalId?: string;
  sessionName?: string;
  pollSessions?: boolean;
}): TerminalResources {
  const { connection, connectionKey, utils } = useMuximodConnection();
  useMuximodEvents(connection);

  const terminalsQuery = useQuery(
    utils.terminals.list.queryOptions({
      input: {},
      staleTime: 5_000,
      retry: 1,
      enabled: Boolean(connection),
    }),
  );

  // The session list does not depend on the terminal; the shared contract key
  // deduplicates it across terminal routes instead of caching copies.
  const sessionsQuery = useQuery(
    utils.sessions.list.queryOptions({
      input: {},
      staleTime: 1_000,
      refetchInterval: pollSessions ? 5_000 : false,
      retry: 1,
      enabled: Boolean(connection) && Boolean(terminalId),
    }),
  );

  const terminals = terminalsQuery.data?.terminals ?? [];
  const sessions = sessionsQuery.data?.sessions ?? [];

  return {
    connection,
    connectionKey,
    utils,
    terminals,
    sessions,
    selectedTerminal: terminals.find((terminal) => terminal.id === terminalId) ?? null,
    selectedSession: sessions.find((session) => session.name === sessionName) ?? null,
    terminalsStatus: queryStatus(terminalsQuery.status),
    terminalsError: errorMessage(terminalsQuery.error),
    sessionsStatus: queryStatus(sessionsQuery.status),
    sessionsError: errorMessage(sessionsQuery.error),
  };
}

export const fallbackTerminal: TerminalEndpoint = {
  id: "local",
  name: "local terminal",
  host: "localhost",
  tailnetIp: "localhost",
  state: "online",
  detail: "muximod",
  lastSeen: "unknown",
};

export const fallbackSession: TmuxSession = {
  name: "session",
  paneCount: 0,
  waitingCount: 0,
  detail: "tmux",
  managed: false,
};

export function queryStatus(status: "pending" | "error" | "success"): "loading" | "error" | "ready" {
  return status === "pending" ? "loading" : status === "error" ? "error" : "ready";
}

export function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : error ? String(error) : null;
}
