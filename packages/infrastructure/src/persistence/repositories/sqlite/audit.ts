import type { AgentDrizzleDatabase } from "../../database-types.js";
import { auditEvents } from "../../schema.js";
import { ambientDatabase } from "../../transaction-context.js";

/** Audit writes use the ambient repository connection when called in a scope. */
export function recordAuditEvent(
  database: AgentDrizzleDatabase,
  event: { eventType: string; entityId: string; payload: unknown; occurredAt?: string },
): void {
  ambientDatabase(database)
    .insert(auditEvents)
    .values({
      eventType: event.eventType,
      entityId: event.entityId,
      payload: JSON.stringify(event.payload),
      occurredAt: event.occurredAt ?? new Date().toISOString(),
    })
    .run();
}
