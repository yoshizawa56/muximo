import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
};

export const panes = sqliteTable(
  "panes",
  {
    id: text("id").primaryKey(),
    hostPaneId: text("tmux_pane_id").notNull(),
    hostServerId: text("tmux_server_id").notNull(),
    agentSessionId: text("agent_session_id"),
    agentExecutionId: text("agent_execution_id"),
    sessionName: text("session_name").notNull(),
    windowId: text("window_id").notNull(),
    kind: text("kind", { enum: ["agent", "shell", "unknown"] }).notNull(),
    name: text("name").notNull(),
    cwd: text("cwd").notNull(),
    workspaceId: text("workspace_id"),
    agentId: text("agent_id"),
    state: text("state", {
      enum: ["starting", "running", "waiting_input", "waiting_approval", "failed", "completed", "stopped"],
    }).notNull(),
    title: text("title"),
    lastSeenAt: text("last_seen_at").notNull(),
    ...timestamps,
  },
  (table) => ({
    hostPaneIndex: uniqueIndex("panes_tmux_server_pane_id_index").on(table.hostServerId, table.hostPaneId),
    agentSessionIndex: index("panes_agent_session_index").on(table.agentSessionId),
  }),
);

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventType: text("event_type").notNull(),
  entityId: text("entity_id").notNull(),
  payload: text("payload").notNull(),
  occurredAt: text("occurred_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  rootPath: text("root_path").notNull(),
  name: text("name").notNull(),
  isGit: integer("is_git", { mode: "boolean" }).notNull(),
  setupScriptPath: text("setup_script_path"),
  cleanupScriptPath: text("cleanup_script_path"),
  worktreeCopyPatterns: text("worktree_copy_patterns").notNull().default("[]"),
  ...timestamps,
});

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    backend: text("backend", { enum: ["codex", "claude", "opencode"] }).notNull(),
    status: text("status", {
      enum: ["starting", "setup", "setup_failed", "ready", "running", "resuming", "interrupted", "exited"],
    }).notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    workspaceName: text("workspace_name").notNull(),
    worktreeRoot: text("worktree_root"),
    worktreePath: text("worktree_path"),
    branch: text("branch"),
    baseCommit: text("base_commit"),
    useWorktree: integer("use_worktree", { mode: "boolean" }).notNull(),
    setupHook: text("setup_hook"),
    cleanupHook: text("cleanup_hook"),
    setupOutputFile: text("setup_output_file"),
    cleanupOutputFile: text("cleanup_output_file"),
    backendSessionId: text("backend_session_id"),
    setupRan: integer("setup_ran", { mode: "boolean" }).notNull(),
    resuming: integer("resuming", { mode: "boolean" }).notNull(),
    baselineStatus: text("baseline_status"),
    lastExitStatus: integer("last_exit_status"),
    executionId: text("execution_id"),
    executionPid: integer("execution_pid"),
    executionStartedAt: text("execution_started_at"),
    ...timestamps,
  },
  (table) => ({
    workspaceNameIndex: uniqueIndex("agent_sessions_workspace_name_index").on(table.workspaceId, table.name),
    workspaceIndex: index("agent_sessions_workspace_index").on(table.workspaceId),
  }),
);

/** Provider-owned Codex implementation state; it is intentionally outside the domain aggregate. */
export const codexSessionStates = sqliteTable("codex_session_states", {
  agentSessionId: text("agent_session_id")
    .primaryKey()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  profile: text("profile"),
  remote: text("remote"),
  sessionBaseline: text("session_baseline"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type PaneRow = typeof panes.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type CodexSessionStateRow = typeof codexSessionStates.$inferSelect;
