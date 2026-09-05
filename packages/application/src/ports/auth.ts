/** One-time challenge awaiting a signed session request. */
export type PendingChallengeRecord = {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
};

/** One-use WebSocket upgrade ticket keyed by its hash. */
export type PendingWsTicketRecord = {
  sessionId: string;
  endpoint: "terminal";
  expiresAt: string;
};

export type ChallengeRateWindow = { startedAt: number; count: number };
