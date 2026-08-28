export type PaneBoardQueryPolicyInput = {
  hasConnection: boolean;
  hasSession: boolean;
  pollWhenHidden: boolean;
  pollIntervalMs?: number;
};

export type PaneBoardQueryPolicy = {
  enabled: boolean;
  refetchInterval: number | false;
};

export function paneBoardQueryPolicy({
  hasConnection,
  hasSession,
  pollWhenHidden,
  pollIntervalMs,
}: PaneBoardQueryPolicyInput): PaneBoardQueryPolicy {
  const enabled = hasConnection && hasSession;
  return {
    enabled,
    refetchInterval: enabled && pollWhenHidden ? (pollIntervalMs ?? 10_000) : false,
  };
}
