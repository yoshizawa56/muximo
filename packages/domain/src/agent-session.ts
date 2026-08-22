import { z } from "zod";
import { AgentSessionId, WorkspaceId } from "./ids.js";
import { applyObjectPatch, type ObjectPatch } from "./patch.js";

export const agentBackends = ["codex", "claude", "opencode"] as const;
export const agentBackendSchema = z.enum(agentBackends);
export type AgentBackend = z.infer<typeof agentBackendSchema>;

export const agentSessionStates = [
  "starting",
  "setup",
  "setup_failed",
  "ready",
  "running",
  "resuming",
  "interrupted",
  "exited",
] as const;
export const agentSessionStateSchema = z.enum(agentSessionStates);
export type AgentSessionState = z.infer<typeof agentSessionStateSchema>;

export const agentSessionNameLimits = {
  maxLength: 64,
  maxUtf8Bytes: 240,
} as const;

const agentSessionNameSchema = z.string().min(1).max(agentSessionNameLimits.maxLength).refine(
  (value) => !/[\u0000\r\n]/.test(value),
  "agent session name contains a control character",
);

const optionalPathSchema = z.string().min(1).optional();
const agentSessionSchema = z.object({
  id: AgentSessionId.schema,
  name: agentSessionNameSchema,
  backend: agentBackendSchema,
  status: agentSessionStateSchema,
  workspaceId: WorkspaceId.schema,
  workspaceRoot: z.string().min(1),
  workspaceName: z.string().min(1),
  worktreeRoot: optionalPathSchema,
  worktreePath: optionalPathSchema,
  branch: z.string().min(1).optional(),
  baseCommit: z.string().min(1).optional(),
  useWorktree: z.boolean(),
  setupHook: optionalPathSchema,
  cleanupHook: optionalPathSchema,
  setupOutputFile: optionalPathSchema,
  cleanupOutputFile: optionalPathSchema,
  backendSessionId: z.string().min(1).optional(),
  codexProfile: z.string().min(1).optional(),
  codexRemote: z.string().optional(),
  setupRan: z.boolean(),
  resuming: z.boolean(),
  baselineStatus: z.string().optional(),
  codexSessionBaseline: z.string().optional(),
  lastExitStatus: z.number().int().optional(),
  executionId: z.string().min(1).optional(),
  executionPid: z.number().int().positive().optional(),
  executionStartedAt: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export type AgentSession = z.infer<typeof agentSessionSchema>;
export type AgentSessionRecord = AgentSession;
export type AgentSessionUpdateInput = ObjectPatch<AgentSession>;

export class InvalidAgentSessionNameError extends Error {
  public readonly code = "invalid_agent_name" as const;

  public constructor() {
    super("Name must contain at least one letter or number after normalization");
    this.name = "InvalidAgentSessionNameError";
  }
}

export const AgentSession = {
  schema: agentSessionSchema,

  validate(input: unknown): AgentSession {
    return agentSessionSchema.parse(input);
  },

  create(input: Omit<AgentSession, "name"> & { name: string }): AgentSession {
    return AgentSession.validate({ ...input, name: normalizeAgentSessionName(input.name) });
  },

  update(entity: AgentSession, input: AgentSessionUpdateInput): AgentSession {
    const current = AgentSession.validate(entity);
    const next = applyObjectPatch(current, input);
    if (input.name !== undefined && typeof input.name === "string") {
      next.name = normalizeAgentSessionName(input.name);
    }
    return AgentSession.validate(next);
  },

  normalizeName: normalizeAgentSessionName,
  hasActiveExecution(entity: AgentSession): boolean {
    const current = AgentSession.validate(entity);
    return (current.status === "running" || current.status === "resuming") && current.executionPid !== undefined;
  },
} as const;

export function normalizeAgentSessionName(value: string): string {
  let normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-")
    .replace(/[^\p{L}\p{N}\p{M}._-]+/gu, "-")
    .replace(/\.{2,}/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/\.lock$/iu, "-lock")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");

  const encoder = new TextEncoder();
  let limited = "";
  let byteLength = 0;
  let codePointCount = 0;
  for (const character of normalized) {
    if (codePointCount >= agentSessionNameLimits.maxLength) break;
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > agentSessionNameLimits.maxUtf8Bytes) break;
    limited += character;
    byteLength += characterBytes;
    codePointCount += 1;
  }
  normalized = limited.replace(/^[._-]+|[._-]+$/gu, "");

  if (!normalized || !/^[\p{L}\p{N}]/u.test(normalized)) throw new InvalidAgentSessionNameError();
  return normalized;
}
