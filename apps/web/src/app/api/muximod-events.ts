import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { isMockMode } from "../../mock/mock-data";
import { createMuximodEventCoordinator } from "./muximod-event-coordinator.js";
import type { MuximodConnection } from "./muximod-client.js";
import { openMuximodEvents } from "./muximod-client.js";
import { muximodQueryUtils } from "./orpc-utils.js";

const coordinatorCache = new WeakMap<MuximodConnection, ReturnType<typeof createMuximodEventCoordinator>>();

export function useMuximodEvents(connection: MuximodConnection | undefined): void {
  const queryClient = useQueryClient();
  const utils = useMemo(() => (connection ? muximodQueryUtils(connection) : undefined), [connection]);

  useEffect(() => {
    if (isMockMode() || !connection?.auth || !utils) return;

    return eventCoordinatorFor(connection).subscribe({ queryClient, utils });
  }, [connection, utils, queryClient]);
}

function eventCoordinatorFor(connection: MuximodConnection): ReturnType<typeof createMuximodEventCoordinator> {
  const cached = coordinatorCache.get(connection);
  if (cached) return cached;
  const coordinator = createMuximodEventCoordinator({ open: () => openMuximodEvents(connection) });
  coordinatorCache.set(connection, coordinator);
  return coordinator;
}
