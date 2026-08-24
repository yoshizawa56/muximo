import type { PaneFilter, PaneRepository } from "@muximo/application";
import { AgentSessionId, Pane, PaneId, type PaneRecord, WorkspaceId } from "@muximo/domain";
import { and, eq, like, lt, notInArray, or } from "drizzle-orm";
import { type PaneRow, panes } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzlePaneRepository extends DrizzleRepositoryBase implements PaneRepository {
  public async list(filter?: PaneFilter): Promise<PaneRecord[]> {
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
    return rows.map(toPaneRecord);
  }

  public async findById(id: PaneId): Promise<PaneRecord | undefined> {
    const row = this.db().select().from(panes).where(eq(panes.id, id)).get();
    return row ? toPaneRecord(row) : undefined;
  }

  public async findByHostPaneIdentity(hostServerId: string, hostPaneId: string): Promise<PaneRecord | undefined> {
    const row = this.db()
      .select()
      .from(panes)
      .where(and(eq(panes.hostServerId, hostServerId), eq(panes.hostPaneId, hostPaneId)))
      .get();
    return row ? toPaneRecord(row) : undefined;
  }

  public async upsert(record: PaneRecord): Promise<void> {
    const now = new Date().toISOString();
    const row = toPaneRow(record, now);
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
          updatedAt: row.updatedAt,
        },
      })
      .run();
  }

  public async pruneStalePanes(
    activePaneIds: readonly PaneId[],
    olderThan: string,
    hostServerScope: string,
  ): Promise<number> {
    // An empty live set is deliberately not treated as authoritative. tmux
    // exits its server after the last session disappears, so deleting all old
    // rows here would turn a temporary tmux outage into data loss.
    if (activePaneIds.length === 0) return 0;

    const condition = and(
      lt(panes.lastSeenAt, olderThan),
      notInArray(panes.id, [...activePaneIds]),
      or(eq(panes.hostServerId, "legacy"), like(panes.hostServerId, `${hostServerScope}:%`)),
    );
    const candidates = this.db().select({ id: panes.id }).from(panes).where(condition).all();
    this.db().delete(panes).where(condition).run();
    return candidates.length;
  }
}

function toPaneRow(record: PaneRecord, now: string): typeof panes.$inferInsert {
  const pane = Pane.restore(record);
  return {
    id: pane.id,
    hostPaneId: pane.hostPaneId,
    hostServerId: pane.hostServerId ?? "legacy",
    agentSessionId: pane.agentSessionId ?? null,
    agentExecutionId: pane.agentExecutionId ?? null,
    sessionName: pane.sessionName,
    windowId: pane.windowId,
    kind: pane.kind,
    name: pane.name,
    cwd: pane.cwd,
    workspaceId: pane.workspaceId ?? null,
    agentId: pane.agentId ?? null,
    state: pane.state,
    title: pane.title ?? null,
    lastSeenAt: pane.lastSeenAt,
    createdAt: now,
    updatedAt: now,
  };
}

function toPaneRecord(row: PaneRow): PaneRecord {
  return Pane.restore({
    id: PaneId.create(row.id),
    hostPaneId: row.hostPaneId,
    ...(row.hostServerId === "legacy" ? {} : { hostServerId: row.hostServerId }),
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
