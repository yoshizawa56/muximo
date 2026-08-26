import { consumeEventIterator } from "@orpc/client";
import type { MuximodEvent } from "@muximo/contract";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateOnMuximodEvent, invalidateOnReconnect } from "./invalidation.js";
import type { MuximodQueryUtils } from "./orpc-utils.js";
import {
  muximodEventReconnectDelay,
  shouldReconnectMuximodEvents,
} from "./muximod-retry-policy.js";

export type MuximodEventSubscriber = {
  queryClient: QueryClient;
  utils: MuximodQueryUtils;
};

type EventIterator = AsyncIteratorObject<MuximodEvent>;
type EventHandlers = {
  onEvent: (event: MuximodEvent) => void;
  onError: (error: unknown) => void;
  onSuccess: () => void;
};
type ConsumeEvents = (iterator: EventIterator, handlers: EventHandlers) => () => Promise<void>;
type TimerHandle = ReturnType<typeof setTimeout>;

export type MuximodEventCoordinatorOptions = {
  open: () => Promise<EventIterator>;
  consume?: ConsumeEvents;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

/**
 * Shares one authenticated event stream across all view models using a
 * connection. The stream only carries invalidation hints; resource data stays
 * in TanStack Query.
 */
export function createMuximodEventCoordinator(options: MuximodEventCoordinatorOptions) {
  const subscribers = new Map<number, MuximodEventSubscriber>();
  const defaultConsume: ConsumeEvents = (iterator, handlers) => consumeEventIterator(iterator, handlers);
  const defaultSetTimer: NonNullable<MuximodEventCoordinatorOptions["setTimer"]> = (callback, delay) =>
    setTimeout(callback, delay);
  const defaultClearTimer: NonNullable<MuximodEventCoordinatorOptions["clearTimer"]> = (timer) => clearTimeout(timer);
  const consume = options.consume ?? defaultConsume;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  let generation = 0;
  let retry = 0;
  let reconnectTimer: TimerHandle | undefined;
  let stopEvents: (() => Promise<void>) | undefined;
  let nextSubscriberId = 0;

  const subscribe = (subscriber: MuximodEventSubscriber): (() => void) => {
    const subscriberId = nextSubscriberId;
    nextSubscriberId += 1;
    subscribers.set(subscriberId, subscriber);
    if (subscribers.size === 1) {
      generation += 1;
      retry = 0;
      void connect(generation);
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(subscriberId);
      if (subscribers.size === 0) disconnect();
    };
  };

  return { subscribe };

  async function connect(currentGeneration: number): Promise<void> {
    if (!isActive(currentGeneration)) return;
    try {
      const iterator = await options.open();
      if (!isActive(currentGeneration)) {
        await iterator.return?.();
        return;
      }

      retry = 0;
      notifyReconnect();
      const stop = consume(iterator, {
        onEvent: (event) => {
          if (isActive(currentGeneration)) notifyEvent(event);
        },
        onError: (error) => {
          if (!isActive(currentGeneration)) return;
          stopEvents = undefined;
          scheduleReconnect(currentGeneration, error);
        },
        onSuccess: () => {
          if (!isActive(currentGeneration)) return;
          stopEvents = undefined;
          scheduleReconnect(currentGeneration);
        },
      });

      if (!isActive(currentGeneration)) {
        await stop();
        return;
      }
      stopEvents = stop;
    } catch (error) {
      scheduleReconnect(currentGeneration, error);
    }
  }

  function scheduleReconnect(currentGeneration: number, error?: unknown): void {
    if (!isActive(currentGeneration) || reconnectTimer !== undefined || !shouldReconnectMuximodEvents(error)) return;
    const delay = muximodEventReconnectDelay(retry, error);
    retry = Math.min(retry + 1, 5);
    reconnectTimer = setTimer(() => {
      reconnectTimer = undefined;
      void connect(currentGeneration);
    }, delay);
  }

  function disconnect(): void {
    generation += 1;
    if (reconnectTimer !== undefined) {
      clearTimer(reconnectTimer);
      reconnectTimer = undefined;
    }
    const stop = stopEvents;
    stopEvents = undefined;
    void stop?.();
  }

  function isActive(currentGeneration: number): boolean {
    return currentGeneration === generation && subscribers.size > 0;
  }

  function notifyEvent(event: MuximodEvent): void {
    for (const subscriber of subscribers.values())
      invalidateOnMuximodEvent(subscriber.queryClient, subscriber.utils, event);
  }

  function notifyReconnect(): void {
    for (const subscriber of subscribers.values()) invalidateOnReconnect(subscriber.queryClient, subscriber.utils);
  }
}
