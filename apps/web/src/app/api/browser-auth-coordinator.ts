export type BrowserAuthSession = {
  serverId: string;
  deviceId: string;
  accessToken: string;
  expiresAt: string;
};

export type BrowserAuthSessionLoader = () => Promise<BrowserAuthSession>;

export type BrowserAuthCoordinator = {
  getAccessToken: () => Promise<string>;
  invalidateAccessToken: () => void;
};

const sessionRefreshMarginMs = 30_000;

/** Owns browser session caching and serializes concurrent session acquisition. */
export function createBrowserAuthCoordinator(loadSession: BrowserAuthSessionLoader): BrowserAuthCoordinator {
  let cachedSession: BrowserAuthSession | undefined;
  let pendingSession: Promise<BrowserAuthSession> | undefined;
  let invalidationGeneration = 0;

  const invalidateAccessToken = (): void => {
    cachedSession = undefined;
    invalidationGeneration += 1;
  };

  const getAccessToken = (): Promise<string> => {
    if (isFresh(cachedSession)) return Promise.resolve(cachedSession.accessToken);
    if (pendingSession) return pendingSession.then((session) => session.accessToken);

    const generation = invalidationGeneration;
    const request = Promise.resolve()
      .then(loadSession)
      .then((session) => {
        if (generation === invalidationGeneration) cachedSession = session;
        return session;
      });
    pendingSession = request;
    request.then(
      () => {
        if (pendingSession === request) pendingSession = undefined;
      },
      () => {
        if (pendingSession === request) pendingSession = undefined;
      },
    );
    return request.then((session) => session.accessToken);
  };

  return {
    getAccessToken,
    invalidateAccessToken,
  };
}

function isFresh(session: BrowserAuthSession | undefined): session is BrowserAuthSession {
  if (!session) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + sessionRefreshMarginMs;
}
