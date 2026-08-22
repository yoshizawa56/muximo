import { useEffect, useMemo } from "react";
import { consumeEventIterator } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import type { MuximodConnection } from "./muximod-client.js";
import { openMuximodEvents } from "./muximod-client.js";
import { invalidateOnMuximodEvent, invalidateOnReconnect } from "./invalidation.js";
import { isMockMode } from "../../mock/mock-data";

export function useMuximodEvents(connection: MuximodConnection | undefined): void {
  const queryClient = useQueryClient();
  const utils = useMemo(() => (connection ? muximodQueryUtils(connection) : undefined), [connection]);

  useEffect(() => {
    if (isMockMode() || !connection?.auth || !utils) return;

    let disposed = false;
    let stopEvents: (() => Promise<void>) | undefined;
    let reconnectTimer: number | undefined;
    let retry = 0;

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      const delay = Math.min(1_000 * 2 ** retry, 30_000);
      retry = Math.min(retry + 1, 5);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed) return;
      try {
        const current = await openMuximodEvents(connection);
        if (disposed) {
          await current.return?.();
          return;
        }
        retry = 0;
        invalidateOnReconnect(queryClient, utils);
        stopEvents = consumeEventIterator(current, {
          onEvent: (event) => invalidateOnMuximodEvent(queryClient, utils, event),
          onError: () => {
            stopEvents = undefined;
            scheduleReconnect();
          },
          onSuccess: () => {
            stopEvents = undefined;
            scheduleReconnect();
          },
        });
      } catch {
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      void stopEvents?.();
      stopEvents = undefined;
    };
  }, [connection, utils, queryClient]);
}
