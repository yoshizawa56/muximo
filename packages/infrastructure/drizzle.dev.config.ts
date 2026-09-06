import { defineConfig } from "drizzle-kit";

const databaseFileOverride = process.env.MUXIMOD_DATABASE_FILE?.trim();

// Authentication tables are bootstrapped by the runtime for legacy database
// compatibility. Keep them out of development pushes so Drizzle Kit does not
// attempt to reconcile their intentionally compatible, but non-identical,
// legacy definitions.
const developmentTables = [
  "agent_execution_receipts",
  "agent_sessions",
  "audit_events",
  "codex_session_states",
  "panes",
  "workspaces",
];

export default defineConfig({
  schema: "./src/persistence/schema.ts",
  tablesFilter: developmentTables,
  dialect: "sqlite",
  dbCredentials: {
    url: databaseFileOverride?.trim() || "./muximod.sqlite",
  },
});
