import { EventPublisher } from "@orpc/server";
import { muximodEventSchema, type MuximodEvent } from "@muximo/contract";

/**
 * Publishes small, non-authoritative invalidation events to SSE subscribers.
 *
 * Event consumers must refetch the corresponding resource. The publisher
 * keeps only the latest pending event for a subscriber, so reconnecting
 * clients always start with a fresh API read instead of replaying an event
 * log.
 */
export class MuximodEventHub {
  private readonly publisher = new EventPublisher<{ muximod: MuximodEvent }>({ maxBufferedEvents: 1 });

  public subscribe(signal: AbortSignal): AsyncIteratorObject<MuximodEvent> {
    return this.publisher.subscribe("muximod", { signal });
  }

  public publish(event: MuximodEvent): void {
    this.publisher.publish("muximod", muximodEventSchema.parse(event));
  }

  public close(): void {
    // EventPublisher subscribers are owned by the request AbortSignal. The
    // server closes those signals when the SSE response is disconnected.
  }
}
