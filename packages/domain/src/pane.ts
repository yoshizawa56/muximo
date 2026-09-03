import { Schema } from "effect";
import { InvalidEntityError } from "./entity-errors.js";
import { AgentSessionId, PaneId, WorkspaceId } from "./ids.js";
import { applyObjectPatch, type EntityPatch } from "./patch.js";

export const paneKinds = ["agent", "shell", "unknown"] as const;
export const paneKindSchema = Schema.Literals(paneKinds);
export type PaneKind = (typeof paneKindSchema)["Type"];

export const paneStates = [
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "failed",
  "completed",
  "stopped",
] as const;
export const paneStateSchema = Schema.Literals(paneStates);
export type PaneState = (typeof paneStateSchema)["Type"];

/** Bare field schemas shared by the entity definition and wire derivations. */
export const PaneFields = {
  id: PaneId.schema,
  hostPaneId: Schema.String.check(Schema.isMinLength(1)),
  hostServerId: Schema.String.check(Schema.isMinLength(1)),
  agentSessionId: AgentSessionId.schema,
  agentExecutionId: Schema.String.check(Schema.isMinLength(1)),
  sessionName: Schema.String.check(Schema.isMinLength(1)),
  windowId: Schema.String.check(Schema.isMinLength(1)),
  kind: paneKindSchema,
  name: Schema.String.check(Schema.isMinLength(1)),
  cwd: Schema.String.check(Schema.isMinLength(1)),
  workspaceId: WorkspaceId.schema,
  agentId: Schema.String.check(Schema.isMinLength(1)),
  state: paneStateSchema,
  title: Schema.String,
  recentOutput: Schema.String,
  lastSeenAt: Schema.String.check(Schema.isMinLength(1)),
  windowName: Schema.String,
  windowIndex: Schema.Number.check(nonNegativeInteger()),
  paneIndex: Schema.Number.check(nonNegativeInteger()),
  left: Schema.Number.check(nonNegativeInteger()),
  top: Schema.Number.check(nonNegativeInteger()),
  width: Schema.Number.check(positiveInteger()),
  height: Schema.Number.check(positiveInteger()),
  windowWidth: Schema.Number.check(positiveInteger()),
  windowHeight: Schema.Number.check(positiveInteger()),
} as const;

export type PaneCreateInput = {
  id: PaneId;
  hostPaneId: string;
  hostServerId: string;
  agentSessionId?: AgentSessionId;
  agentExecutionId?: string;
  sessionName: string;
  windowId: string;
  kind: PaneKind;
  name: string;
  cwd: string;
  workspaceId?: WorkspaceId;
  agentId?: string;
  initialState: PaneState;
  title?: string;
  recentOutput?: string;
  lastSeenAt: string;
  windowName?: string;
  windowIndex?: number;
  paneIndex?: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  windowWidth?: number;
  windowHeight?: number;
};

const paneImmutableFields = ["id", "hostPaneId", "hostServerId", "state"] as const;
type PaneImmutableFields = (typeof paneImmutableFields)[number];
export type PaneUpdateInput = EntityPatch<(typeof Pane)["Encoded"], PaneImmutableFields>;

export type PaneStateTransition = {
  from: PaneState;
  to: PaneState;
  reason: string;
  at: string;
};

const terminalStates = new Set<PaneState>(["failed", "completed", "stopped"]);
const immutablePaneUpdateKeys = new Set<string>(paneImmutableFields);

export class Pane extends Schema.Class<Pane>("Pane")({
  id: PaneId.schema,
  hostPaneId: PaneFields.hostPaneId,
  hostServerId: PaneFields.hostServerId,
  agentSessionId: Schema.optional(AgentSessionId.schema),
  agentExecutionId: Schema.optional(PaneFields.agentExecutionId),
  sessionName: PaneFields.sessionName,
  windowId: PaneFields.windowId,
  kind: paneKindSchema,
  name: PaneFields.name,
  cwd: PaneFields.cwd,
  workspaceId: Schema.optional(WorkspaceId.schema),
  agentId: Schema.optional(PaneFields.agentId),
  state: paneStateSchema,
  title: Schema.optional(PaneFields.title),
  recentOutput: Schema.optional(PaneFields.recentOutput),
  lastSeenAt: PaneFields.lastSeenAt,
  windowName: Schema.optional(PaneFields.windowName),
  windowIndex: Schema.optional(PaneFields.windowIndex),
  paneIndex: Schema.optional(PaneFields.paneIndex),
  left: Schema.optional(PaneFields.left),
  top: Schema.optional(PaneFields.top),
  width: Schema.optional(PaneFields.width),
  height: Schema.optional(PaneFields.height),
  windowWidth: Schema.optional(PaneFields.windowWidth),
  windowHeight: Schema.optional(PaneFields.windowHeight),
}) {
  static create(input: PaneCreateInput): Pane {
    const { initialState, ...record } = input;
    return decodePane({ ...record, state: initialState });
  }

  /** Rehydrates a persisted pane. This is the only re-entry point for raw data. */
  static restore(input: unknown): Pane {
    return decodePane(input);
  }

  update(input: PaneUpdateInput): Pane {
    for (const key of Object.keys(input)) {
      if (immutablePaneUpdateKeys.has(key)) {
        throw new Error(`Pane update cannot change immutable field: ${key}`);
      }
    }
    const current = { ...this } as (typeof Pane)["Encoded"];
    return decodePane(applyObjectPatch(current, input));
  }

  /** Reinitializes a pane state when its host pane starts a new execution. */
  resetTo(next: PaneState, reason: string, at: string): Pane {
    validatePaneStateChange(next, reason, at);
    return decodePane({ ...this, state: next, lastSeenAt: at });
  }

  transitionTo(next: PaneState, reason: string, at: string): Pane {
    const transition = transitionPaneState(this.state, next, reason, at);
    return decodePane({ ...this, state: transition.to, lastSeenAt: at });
  }
}

const decodePane = (input: unknown): Pane => {
  try {
    return Schema.decodeUnknownSync(Pane, { onExcessProperty: "error" })(input);
  } catch (error) {
    throw new InvalidEntityError("Pane", { cause: error });
  }
};

export function canTransitionPaneState(from: PaneState, to: PaneState): boolean {
  decodePaneState(from);
  decodePaneState(to);
  if (from === to) return true;
  if (terminalStates.has(from)) return false;
  if (to === "starting") return from === "starting";
  return true;
}

export function transitionPaneState(
  current: PaneState,
  next: PaneState,
  reason: string,
  at: string,
): PaneStateTransition {
  if (!reason.trim()) throw new Error("Pane state transition requires a reason");
  if (!at.trim()) throw new Error("Pane state transition requires a time");
  if (!canTransitionPaneState(current, next)) {
    throw new Error(`Invalid pane state transition: ${current} -> ${next}`);
  }
  return { from: current, to: next, reason, at };
}

export function isAttentionState(state: PaneState): boolean {
  decodePaneState(state);
  return state === "waiting_input" || state === "waiting_approval" || state === "failed";
}

const decodePaneState = (state: PaneState): PaneState => {
  return Schema.decodeUnknownSync(paneStateSchema)(state);
};

function validatePaneStateChange(next: PaneState, reason: string, at: string): void {
  decodePaneState(next);
  if (!reason.trim()) throw new Error("Pane state transition requires a reason");
  if (!at.trim()) throw new Error("Pane state transition requires a time");
}

function nonNegativeInteger() {
  return Schema.makeFilter((value: number) => Number.isInteger(value) && value >= 0);
}

function positiveInteger() {
  return Schema.makeFilter((value: number) => Number.isInteger(value) && value > 0);
}
