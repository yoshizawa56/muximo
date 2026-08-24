import { z } from "zod";
import { AgentSessionId, PaneId, WorkspaceId } from "./ids.js";
import { applyObjectPatch, type ObjectPatch } from "./patch.js";

export const paneKinds = ["agent", "shell", "unknown"] as const;
export const paneKindSchema = z.enum(paneKinds);
export type PaneKind = z.infer<typeof paneKindSchema>;

export const paneStates = [
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "failed",
  "completed",
  "stopped",
] as const;
export const paneStateSchema = z.enum(paneStates);
export type PaneState = z.infer<typeof paneStateSchema>;

const paneSchema = z
  .object({
    id: PaneId.schema,
    hostPaneId: z.string().min(1),
    hostServerId: z.string().min(1).optional(),
    agentSessionId: AgentSessionId.schema.optional(),
    agentExecutionId: z.string().min(1).optional(),
    sessionName: z.string().min(1),
    windowId: z.string().min(1),
    kind: paneKindSchema,
    name: z.string().min(1),
    cwd: z.string().min(1),
    workspaceId: WorkspaceId.schema.optional(),
    agentId: z.string().min(1).optional(),
    state: paneStateSchema,
    title: z.string().optional(),
    recentOutput: z.string().optional(),
    lastSeenAt: z.string().min(1),
    windowName: z.string().optional(),
    windowIndex: z.number().int().min(0).optional(),
    paneIndex: z.number().int().min(0).optional(),
    left: z.number().int().min(0).optional(),
    top: z.number().int().min(0).optional(),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    windowWidth: z.number().int().min(1).optional(),
    windowHeight: z.number().int().min(1).optional(),
  })
  .strict();

export type Pane = z.infer<typeof paneSchema>;
export type PaneRecord = Pane;

export type PaneCreateInput = {
  id: PaneId;
  hostPaneId: string;
  hostServerId?: string;
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

type PaneMutableFields = Omit<Pane, "id" | "hostPaneId" | "hostServerId" | "state">;
export type PaneUpdateInput = ObjectPatch<PaneMutableFields>;

export type PaneStateTransition = {
  from: PaneState;
  to: PaneState;
  reason: string;
  at: string;
};

const terminalStates = new Set<PaneState>(["failed", "completed", "stopped"]);
const immutablePaneUpdateKeys = new Set(["id", "hostPaneId", "hostServerId", "state"]);

const parsePane = (input: unknown): Pane => paneSchema.parse(input);

export const Pane = {
  schema: paneSchema,

  /** Rehydrates a persisted pane. This is the only re-entry point for raw data. */
  restore(input: unknown): Pane {
    return parsePane(input);
  },

  create(input: PaneCreateInput): Pane {
    const { initialState, ...record } = input;
    return parsePane({ ...record, state: initialState });
  },

  update(entity: Pane, input: PaneUpdateInput): Pane {
    const current = parsePane(entity);
    for (const key of Object.keys(input)) {
      if (immutablePaneUpdateKeys.has(key)) {
        throw new Error(`Pane update cannot change immutable field: ${key}`);
      }
    }
    return parsePane(applyObjectPatch(current, input));
  },

  canTransitionState: canTransitionPaneState,
  transitionState: transitionPane,
  isAttentionState,
} as const;

export function canTransitionPaneState(from: PaneState, to: PaneState): boolean {
  paneStateSchema.parse(from);
  paneStateSchema.parse(to);
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

export function transitionPane(entity: Pane, next: PaneState, reason: string, at: string): Pane {
  const current = parsePane(entity);
  const transition = transitionPaneState(current.state, next, reason, at);
  return parsePane({ ...current, state: transition.to, lastSeenAt: at });
}

export function isAttentionState(state: PaneState): boolean {
  paneStateSchema.parse(state);
  return state === "waiting_input" || state === "waiting_approval" || state === "failed";
}
