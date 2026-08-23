import type {
  AuthChallengeStorePort,
  AuthRateLimitStorePort,
  AuthWsTicketStorePort,
  ChallengeRateWindow,
  MuximodSocket,
  PendingChallengeRecord,
  PendingWsTicketRecord,
  TrackedSocketRegistryPort,
} from "@muximo/application";

type TrackedSockets = {
  deviceId: string;
  sockets: Set<MuximodSocket>;
  expiryTimers: Map<MuximodSocket, ReturnType<typeof setTimeout>>;
};

export class MemoryAuthChallengeStore implements AuthChallengeStorePort {
  private readonly challenges = new Map<string, PendingChallengeRecord>();

  public put(record: PendingChallengeRecord): void {
    this.challenges.set(record.challengeId, record);
  }

  public take(challengeId: string): PendingChallengeRecord | null {
    const record = this.challenges.get(challengeId) ?? null;
    this.challenges.delete(challengeId);
    return record;
  }

  public sweepExpired(nowIso: string): void {
    for (const [challengeId, record] of this.challenges) {
      if (record.expiresAt <= nowIso) this.challenges.delete(challengeId);
    }
  }

  public size(): number {
    return this.challenges.size;
  }
}

export class MemoryAuthRateLimitStore implements AuthRateLimitStorePort {
  private readonly windows = new Map<string, ChallengeRateWindow>();

  public window(deviceId: string): ChallengeRateWindow | null {
    return this.windows.get(deviceId) ?? null;
  }

  public setWindow(deviceId: string, window: ChallengeRateWindow): void {
    this.windows.set(deviceId, window);
  }
}

export class MemoryAuthWsTicketStore implements AuthWsTicketStorePort {
  private readonly tickets = new Map<string, PendingWsTicketRecord>();

  public put(ticketHash: string, record: PendingWsTicketRecord): void {
    this.tickets.set(ticketHash, record);
  }

  public take(ticketHash: string): PendingWsTicketRecord | null {
    const record = this.tickets.get(ticketHash) ?? null;
    this.tickets.delete(ticketHash);
    return record;
  }
}

export class MemoryTrackedSocketRegistry implements TrackedSocketRegistryPort {
  private readonly tracked = new Map<string, TrackedSockets>();

  public track(input: { sessionId: string; deviceId: string; socket: MuximodSocket; expiresAtMs: number }): void {
    const tracked = this.tracked.get(input.sessionId) ?? {
      deviceId: input.deviceId,
      sockets: new Set<MuximodSocket>(),
      expiryTimers: new Map<MuximodSocket, ReturnType<typeof setTimeout>>(),
    };
    tracked.sockets.add(input.socket);
    const remainingMs = Math.max(0, input.expiresAtMs - Date.now());
    const expiryTimer = setTimeout(() => input.socket.close(4001, "session expired"), remainingMs);
    (expiryTimer as unknown as { unref?: () => void }).unref?.();
    tracked.expiryTimers.set(input.socket, expiryTimer);
    this.tracked.set(input.sessionId, tracked);
    let removeCloseListener: () => void = () => undefined;
    removeCloseListener = input.socket.onClose(() => {
      clearTimeout(expiryTimer);
      tracked.sockets.delete(input.socket);
      tracked.expiryTimers.delete(input.socket);
      if (tracked.sockets.size === 0) this.tracked.delete(input.sessionId);
      removeCloseListener();
    });
  }

  public closeForDevice(deviceId: string, code: number, reason: string): void {
    for (const [sessionId, tracked] of this.tracked) {
      if (tracked.deviceId !== deviceId) continue;
      for (const socket of tracked.sockets) socket.close(code, reason);
      for (const timer of tracked.expiryTimers.values()) clearTimeout(timer);
      this.tracked.delete(sessionId);
    }
  }
}
