import { Schema } from "effect";
import { ImmutableEntityFieldError, InvalidEntityError } from "./entity-errors.js";
import { AgentSessionId, WorkspaceId } from "./ids.js";
import { applyObjectPatch, type EntityPatch } from "./patch.js";

export const agentBackends = ["codex", "claude", "opencode"] as const;
export const agentBackendSchema = Schema.Literals(agentBackends);
export type AgentBackend = (typeof agentBackendSchema)["Type"];

export const agentSessionStates = [
  "starting",
  "setup",
  "setup_failed",
  "ready",
  "running",
  "resuming",
  "recovering",
  "interrupted",
  "exited",
] as const;
export const agentSessionStateSchema = Schema.Literals(agentSessionStates);
export type AgentSessionState = (typeof agentSessionStateSchema)["Type"];

export const agentSessionNameLimits = {
  maxLength: 64,
  maxUtf8Bytes: 240,
} as const;

const agentSessionNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(agentSessionNameLimits.maxLength),
  Schema.isPattern(/^[^\u0000\r\n]*$/),
);

const optionalPathSchema = Schema.String.check(Schema.isMinLength(1));

/** Bare field schemas shared by the entity definition and wire derivations. */
export const AgentSessionFields = {
  id: AgentSessionId.schema,
  name: agentSessionNameSchema,
  backend: agentBackendSchema,
  status: agentSessionStateSchema,
  workspaceId: WorkspaceId.schema,
  workspaceRoot: Schema.String.check(Schema.isMinLength(1)),
  workspaceName: Schema.String.check(Schema.isMinLength(1)),
  worktreeRoot: optionalPathSchema,
  worktreePath: optionalPathSchema,
  branch: Schema.String.check(Schema.isMinLength(1)),
  baseCommit: Schema.String.check(Schema.isMinLength(1)),
  useWorktree: Schema.Boolean,
  setupHook: optionalPathSchema,
  cleanupHook: optionalPathSchema,
  setupOutputFile: optionalPathSchema,
  cleanupOutputFile: optionalPathSchema,
  backendSessionId: Schema.String.check(Schema.isMinLength(1)),
  setupRan: Schema.Boolean,
  resuming: Schema.Boolean,
  baselineStatus: Schema.String,
  lastExitStatus: Schema.Number.check(Schema.isInt()),
  executionId: Schema.String.check(Schema.isMinLength(1)),
  executionPid: Schema.Number.check(positiveInteger()),
  executionStartedAt: Schema.String.check(Schema.isMinLength(1)),
  executionOwnerPid: Schema.Number.check(positiveInteger()),
  executionOwnerStartedAt: Schema.String.check(Schema.isMinLength(1)),
  lastActivityAt: Schema.String.check(Schema.isMinLength(1)),
} as const;

const agentSessionImmutableFields = ["id"] as const;
type AgentSessionImmutableFields = (typeof agentSessionImmutableFields)[number];
export type AgentSessionEncoded = (typeof AgentSession)["Encoded"];
export type AgentSessionUpdateInput = EntityPatch<AgentSessionEncoded, AgentSessionImmutableFields>;

export class InvalidAgentSessionNameError extends Error {
  public readonly _tag = "InvalidAgentSessionNameError" as const;
  public readonly code = "invalid_agent_name" as const;

  public constructor() {
    super("Name must contain at least one letter or number after normalization");
    this.name = "InvalidAgentSessionNameError";
  }
}

export class AgentSession extends Schema.Class<AgentSession>("AgentSession")({
  id: AgentSessionId.schema,
  name: agentSessionNameSchema,
  backend: agentBackendSchema,
  status: agentSessionStateSchema,
  workspaceId: WorkspaceId.schema,
  workspaceRoot: AgentSessionFields.workspaceRoot,
  workspaceName: AgentSessionFields.workspaceName,
  worktreeRoot: Schema.optional(optionalPathSchema),
  worktreePath: Schema.optional(optionalPathSchema),
  branch: Schema.optional(AgentSessionFields.branch),
  baseCommit: Schema.optional(AgentSessionFields.baseCommit),
  useWorktree: Schema.Boolean,
  setupHook: Schema.optional(optionalPathSchema),
  cleanupHook: Schema.optional(optionalPathSchema),
  setupOutputFile: Schema.optional(optionalPathSchema),
  cleanupOutputFile: Schema.optional(optionalPathSchema),
  backendSessionId: Schema.optional(AgentSessionFields.backendSessionId),
  setupRan: Schema.Boolean,
  resuming: Schema.Boolean,
  baselineStatus: Schema.optional(AgentSessionFields.baselineStatus),
  lastExitStatus: Schema.optional(AgentSessionFields.lastExitStatus),
  executionId: Schema.optional(AgentSessionFields.executionId),
  executionPid: Schema.optional(AgentSessionFields.executionPid),
  executionStartedAt: Schema.optional(AgentSessionFields.executionStartedAt),
  executionOwnerPid: Schema.optional(AgentSessionFields.executionOwnerPid),
  executionOwnerStartedAt: Schema.optional(AgentSessionFields.executionOwnerStartedAt),
  lastActivityAt: AgentSessionFields.lastActivityAt,
}) {
  static create(input: Omit<AgentSessionEncoded, "name"> & { name: string }): AgentSession {
    return decodeAgentSession({ ...input, name: normalizeAgentSessionName(input.name) });
  }

  /** Rehydrates a persisted agent session. This is the only re-entry point for raw data. */
  static restore(input: unknown): AgentSession {
    return decodeAgentSession(input);
  }

  update(input: AgentSessionUpdateInput): AgentSession {
    for (const key of Object.keys(input)) {
      if (immutableAgentSessionUpdateKeys.has(key)) {
        throw new ImmutableEntityFieldError("AgentSession", key);
      }
    }
    const current = { ...this } as AgentSessionEncoded;
    const patched = applyObjectPatch(current, input);
    const next =
      input.name !== undefined && typeof input.name === "string"
        ? { ...patched, name: normalizeAgentSessionName(input.name) }
        : patched;
    return decodeAgentSession(next);
  }

  hasActiveExecution(): boolean {
    return (
      (this.status === "running" || this.status === "resuming" || this.status === "recovering") &&
      this.executionId !== undefined
    );
  }

  static normalizeName = normalizeAgentSessionName;
}

const decodeAgentSession = (input: unknown): AgentSession => {
  try {
    return Schema.decodeUnknownSync(AgentSession, { onExcessProperty: "error" })(input);
  } catch (error) {
    throw new InvalidEntityError("AgentSession", { cause: error });
  }
};

const immutableAgentSessionUpdateKeys = new Set<string>(agentSessionImmutableFields);

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

function positiveInteger() {
  return Schema.makeFilter((value: number) => Number.isInteger(value) && value > 0);
}
