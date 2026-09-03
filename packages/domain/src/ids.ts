import { Schema } from "effect";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

const paneIdSchema = nonEmptyString.pipe(Schema.brand("PaneId"));
const workspaceIdSchema = nonEmptyString.pipe(Schema.brand("WorkspaceId"));
const agentSessionIdSchema = nonEmptyString.pipe(Schema.brand("AgentSessionId"));

export type PaneId = (typeof paneIdSchema)["Type"];
export type WorkspaceId = (typeof workspaceIdSchema)["Type"];
export type AgentSessionId = (typeof agentSessionIdSchema)["Type"];

export const PaneId = {
  schema: paneIdSchema,
  create(value: string): PaneId {
    return Schema.decodeUnknownSync(paneIdSchema)(value);
  },
} as const;

export const WorkspaceId = {
  schema: workspaceIdSchema,
  create(value: string): WorkspaceId {
    return Schema.decodeUnknownSync(workspaceIdSchema)(value);
  },
} as const;

export const AgentSessionId = {
  schema: agentSessionIdSchema,
  create(value: string): AgentSessionId {
    return Schema.decodeUnknownSync(agentSessionIdSchema)(value);
  },
} as const;
