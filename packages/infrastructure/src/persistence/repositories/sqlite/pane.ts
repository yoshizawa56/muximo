import type { ApplicationClock, ApplicationEffect, PaneFilter, PaneRepository } from "@muximo/application";
import { AgentSessionId, Pane, PaneId, WorkspaceId } from "@muximo/domain";
import { and, eq, like, lt, notInArray } from "drizzle-orm";
import { fromPromise } from "../../../effect.js";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { type PaneRow, panes } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzlePaneRepository extends DrizzleRepositoryBase implements PaneRepository {
  public constructor(
    database: AgentDrizzleDatabase,
    private readonly clock: ApplicationClock = { now: () => new Date().toISOString() },
  ) {
    super(database);
  }
  public list(filter?: PaneFilter): ApplicationEffect<Pane[]> {
    return fromPromise(() => {
      const conditions = [];
      if (filter?.state) conditions.push(eq(panes.state, filter.state));
      if (filter?.kind) conditions.push(eq(panes.kind, filter.kind));
      if (filter?.sessionName) conditions.push(eq(panes.sessionName, filter.sessionName));

      const rows = conditions.length
        ? this.db()
            .select()
            .from(panes)
            .where(and(...conditions))
            .all()
        : this.db().select().from(panes).all();
      return rows.map(toPane);
    });
  }

  public findById(id: PaneId): ApplicationEffect<Pane | undefined> {
    return fromPromise(() => {
      const row = this.db().select().from(panes).where(eq(panes.id, id)).get();
      return row ? toPane(row) : undefined;
    });
  }

  public findByHostPaneIdentity(hostServerId: string, hostPaneId: string): ApplicationEffect<Pane | undefined> {
    return fromPromise(() => {
      const row = this.db()
        .select()
        .from(panes)
        .where(and(eq(panes.hostServerId, hostServerId), eq(panes.hostPaneId, hostPaneId)))
        .get();
      return row ? toPane(row) : undefined;
    });
  }

  public upsert(record: Pane): ApplicationEffect<void> {
    return fromPromise(() => {
      const row = toPaneRow(record, this.clock.now());
      this.db()
        .insert(panes)
        .values(row)
        .onConflictDoUpdate({
          target: [panes.hostServerId, panes.hostPaneId],
          set: {
            hostPaneId: row.hostPaneId,
            hostServerId: row.hostServerId,
            agentSessionId: row.agentSessionId,
            agentExecutionId: row.agentExecutionId,
            sessionName: row.sessionName,
            windowId: row.windowId,
            kind: row.kind,
            name: row.name,
            cwd: row.cwd,
            workspaceId: row.workspaceId,
            agentId: row.agentId,
            state: row.state,
            title: row.title,
            lastSeenAt: row.lastSeenAt,
          },
        })
        .run();
    });
  }

  public pruneStalePanes(
    activePaneIds: readonly PaneId[],
    olderThan: string,
    hostServerScope: string,
  ): ApplicationEffect<number> {
    return fromPromise(() => {
      // An empty live set is deliberately not treated as authoritative. tmux
      // exits its server after the last session disappears, so deleting all old
      // rows here would turn a temporary tmux outage into data loss.
      if (activePaneIds.length === 0) return 0;

      const condition = and(
        lt(panes.lastSeenAt, olderThan),
        notInArray(panes.id, [...activePaneIds]),
        like(panes.hostServerId, `${hostServerScope}:%`),
      );
      const candidates = this.db().select({ id: panes.id }).from(panes).where(condition).all();
      this.db().delete(panes).where(condition).run();
      return candidates.length;
    });
  }
}

function toPaneRow(record: Pane, now: string): typeof panes.$inferInsert {
  return {
    id: record.id,
    hostPaneId: record.hostPaneId,
    hostServerId: record.hostServerId,
    agentSessionId: record.agentSessionId ?? null,
    agentExecutionId: record.agentExecutionId ?? null,
    sessionName: record.sessionName,
    windowId: record.windowId,
    kind: record.kind,
    name: record.name,
    cwd: record.cwd,
    workspaceId: record.workspaceId ?? null,
    agentId: record.agentId ?? null,
    state: record.state,
    title: record.title ?? null,
    lastSeenAt: record.lastSeenAt,
    createdAt: now,
    updatedAt: now,
  };
}

function toPane(row: PaneRow): Pane {
  return Pane.restore({
    id: PaneId.create(row.id),
    hostPaneId: row.hostPaneId,
    hostServerId: row.hostServerId,
    ...(row.agentSessionId ? { agentSessionId: AgentSessionId.create(row.agentSessionId) } : {}),
    ...(row.agentExecutionId ? { agentExecutionId: row.agentExecutionId } : {}),
    sessionName: row.sessionName,
    windowId: row.windowId,
    kind: row.kind,
    name: row.name,
    cwd: row.cwd,
    ...(row.workspaceId ? { workspaceId: WorkspaceId.create(row.workspaceId) } : {}),
    ...(row.agentId ? { agentId: row.agentId } : {}),
    state: row.state,
    ...(row.title !== null ? { title: row.title } : {}),
    lastSeenAt: row.lastSeenAt,
  });
}
