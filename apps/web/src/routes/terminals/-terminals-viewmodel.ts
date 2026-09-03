import type { TerminalEndpoint } from "@muximo/contract/api";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { muximodErrorMessage } from "../../app/api/muximod-error.js";
import { useMuximodEvents } from "../../app/api/muximod-events";
import { useMuximodConnection } from "../../app/api/use-muximod-connection";

export type TerminalsViewModel = {
  connectionName: string | null;
  terminals: readonly TerminalEndpoint[];
  status?: "loading" | "ready" | "error";
  errorMessage?: string | null;
  onSelectTerminal: (terminal: TerminalEndpoint) => void;
  onOpenSettings: () => void;
  onOpenWorkspaces: () => void;
};

export function useTerminalsViewModel(): TerminalsViewModel {
  const navigate = useNavigate();
  const { connection, profile, utils } = useMuximodConnection();
  useMuximodEvents(connection);
  const terminalsQuery = useQuery(
    utils.terminals.list.queryOptions({
      input: {},
      staleTime: 5_000,
      enabled: Boolean(connection),
    }),
  );
  const terminals = terminalsQuery.data?.terminals ?? [];

  return {
    connectionName: profile?.name ?? null,
    terminals,
    status: connection ? queryStatus(terminalsQuery.status) : undefined,
    errorMessage: connection ? errorMessage(terminalsQuery.error) : null,
    onSelectTerminal: (terminal: TerminalEndpoint) => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId: terminal.id } });
    },
    onOpenSettings: () => {
      void navigate({ to: "/settings" });
    },
    onOpenWorkspaces: () => {
      void navigate({ to: "/workspaces" });
    },
  };
}

function queryStatus(status: "pending" | "error" | "success"): "loading" | "error" | "ready" {
  return status === "pending" ? "loading" : status === "error" ? "error" : "ready";
}

function errorMessage(error: unknown): string | null {
  return error ? muximodErrorMessage(error) : null;
}
