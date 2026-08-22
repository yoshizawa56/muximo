import { z } from "zod";

const paneIdSchema = z.string().min(1).brand<"PaneId">();
const workspaceIdSchema = z.string().min(1).brand<"WorkspaceId">();
const agentSessionIdSchema = z.string().min(1).brand<"AgentSessionId">();
const paneIdValueSchema = z.string().min(1);
const workspaceIdValueSchema = z.string().min(1);
const agentSessionIdValueSchema = z.string().min(1);

export type PaneId = z.infer<typeof paneIdSchema>;
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type AgentSessionId = z.infer<typeof agentSessionIdSchema>;

export const PaneId = {
  schema: paneIdSchema,
  valueSchema: paneIdValueSchema,
  create(value: string): PaneId {
    return paneIdSchema.parse(value);
  },
} as const;

export const WorkspaceId = {
  schema: workspaceIdSchema,
  valueSchema: workspaceIdValueSchema,
  create(value: string): WorkspaceId {
    return workspaceIdSchema.parse(value);
  },
} as const;

export const AgentSessionId = {
  schema: agentSessionIdSchema,
  valueSchema: agentSessionIdValueSchema,
  create(value: string): AgentSessionId {
    return agentSessionIdSchema.parse(value);
  },
} as const;
