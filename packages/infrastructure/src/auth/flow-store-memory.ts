import type {
  AuthChallengeStorePort,
  AuthConnectionPort,
  AuthRateLimitStorePort,
  AuthWsTicketStorePort,
  ChallengeRateWindow,
  Clock,
  PendingChallengeRecord,
  PendingWsTicketRecord,
} from "@muximo/application";
import { authRateWindowMs } from "@muximo/application";
import { type MuximodSocket, muximodSocketReadyState } from "../http/socket.js";

export class MemoryAuthChallengeStore implements AuthChallengeStorePort {
  private readonly challenges = new Map<string, PendingChallengeRecord>();

  public put(record: PendingChallengeRecord): void {
    this.challenges.set(record.challengeId, record);
  }

  public take(challengeId: string): PendingChallengeRecord | undefined {
    const record = this.challenges.get(challengeId);
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

  public window(deviceId: string): ChallengeRateWindow | undefined {
    return this.windows.get(deviceId);
  }

  public setWindow(deviceId: string, window: ChallengeRateWindow): void {
    this.windows.set(deviceId, window);
  }

  public sweepExpired(nowMs: number): void {
    for (const [deviceId, window] of this.windows) {
      if (nowMs - window.startedAt >= authRateWindowMs) this.windows.delete(deviceId);
    }
  }

  public size(): number {
    return this.windows.size;
  }
}

export class MemoryAuthWsTicketStore implements AuthWsTicketStorePort {
  private readonly tickets = new Map<string, PendingWsTicketRecord>();

  public put(ticketHash: string, record: PendingWsTicketRecord): void {
    this.tickets.set(ticketHash, record);
  }

  public take(ticketHash: string): PendingWsTicketRecord | undefined {
    const record = this.tickets.get(ticketHash);
    this.tickets.delete(ticketHash);
    return record;
  }

  public sweepExpired(nowIso: string): void {
    for (const [ticketHash, record] of this.tickets) {
      if (record.expiresAt <= nowIso) this.tickets.delete(ticketHash);
    }
  }

  public size(): number {
    return this.tickets.size;
  }
}

export type AuthFlowSweepScheduler = {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
};

export type AuthFlowLifecycleOptions = {
  challenges: AuthChallengeStorePort;
  rateLimits: AuthRateLimitStorePort;
  wsTickets: AuthWsTicketStorePort;
  clock: Clock;
  intervalMs?: number;
  scheduler?: AuthFlowSweepScheduler;
};

export const minimumAuthFlowSweepIntervalMs = 1_000;

/** Composition-owned lifecycle for all in-memory authentication flow state. */
export class MemoryAuthFlowLifecycle {
  private readonly intervalMs: number;
  private readonly scheduler: AuthFlowSweepScheduler;
  private timer: unknown;

  public constructor(private readonly options: AuthFlowLifecycleOptions) {
    const intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isInteger(intervalMs) || intervalMs < minimumAuthFlowSweepIntervalMs) {
      throw new Error(`auth flow sweep interval must be an integer >= ${minimumAuthFlowSweepIntervalMs}`);
    }
    this.intervalMs = intervalMs;
    this.scheduler = options.scheduler ?? {
      setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  public start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.scheduler.setInterval(() => this.sweep(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  public stop(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  public sweep(): void {
    const now = this.options.clock.now();
    this.options.challenges.sweepExpired(now.toISOString());
    this.options.rateLimits.sweepExpired(now.getTime());
    this.options.wsTickets.sweepExpired(now.toISOString());
  }
}

export type AuthConnectionScheduler = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type AuthConnectionRegistryOptions = {
  now?: () => number;
  scheduler?: AuthConnectionScheduler;
};

type TrackedConnection = {
  sessionId: string;
  deviceId: string;
  socket: MuximodSocket;
  expiryTimer: unknown;
  removeCloseListener: () => void;
  active: boolean;
};

/** Owns authenticated transport registration and its concrete close lifecycle. */
export class MemoryAuthenticatedConnectionRegistry implements AuthConnectionPort {
  private readonly tracked = new Set<TrackedConnection>();
  private readonly now: () => number;
  private readonly scheduler: AuthConnectionScheduler;

  public constructor(options: AuthConnectionRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? {
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  }

  public register(input: { sessionId: string; deviceId: string; expiresAt: string; socket: MuximodSocket }): void {
    const connection: TrackedConnection = {
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      socket: input.socket,
      expiryTimer: undefined,
      removeCloseListener: () => undefined,
      active: true,
    };
    this.tracked.add(connection);
    connection.removeCloseListener = input.socket.onClose(() => this.remove(connection));
    if (
      input.socket.readyState !== muximodSocketReadyState.connecting &&
      input.socket.readyState !== muximodSocketReadyState.open
    ) {
      this.remove(connection);
      return;
    }
    const expiresAtMs = new Date(input.expiresAt).getTime();
    const remainingMs = Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - this.now()) : 0;
    connection.expiryTimer = this.scheduler.setTimeout(
      () => this.disconnect(connection, "session expired"),
      remainingMs,
    );
    (connection.expiryTimer as { unref?: () => void } | undefined)?.unref?.();
  }

  public async disconnectDevice(deviceId: string): Promise<void> {
    for (const connection of [...this.tracked]) {
      if (connection.deviceId === deviceId) this.disconnect(connection, "device revoked");
    }
  }

  public async disconnectSession(sessionId: string): Promise<void> {
    for (const connection of [...this.tracked]) {
      if (connection.sessionId === sessionId) this.disconnect(connection, "session revoked");
    }
  }

  public get size(): number {
    return this.tracked.size;
  }

  private disconnect(connection: TrackedConnection, reason: string): void {
    if (!this.remove(connection)) return;
    if (
      connection.socket.readyState === muximodSocketReadyState.open ||
      connection.socket.readyState === muximodSocketReadyState.connecting
    ) {
      connection.socket.close(4001, reason);
    }
  }

  private remove(connection: TrackedConnection): boolean {
    if (!connection.active) return false;
    connection.active = false;
    this.tracked.delete(connection);
    if (connection.expiryTimer !== undefined) this.scheduler.clearTimeout(connection.expiryTimer);
    connection.removeCloseListener();
    return true;
  }
}
