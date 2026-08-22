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

const paneSchema = z.object({
  id: PaneId.schema,
  tmuxPaneId: z.string().min(1),
  tmuxServerId: z.string().min(1).optional(),
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
}).strict();

export type Pane = z.infer<typeof paneSchema>;
export type PaneRecord = Pane;
export type PaneUpdateInput = ObjectPatch<Pane>;

export type PaneStateTransition = {
  from: PaneState;
  to: PaneState;
  reason: string;
  at: string;
};

const terminalStates = new Set<PaneState>(["failed", "completed", "stopped"]);

export const Pane = {
  schema: paneSchema,

  validate(input: unknown): Pane {
    return paneSchema.parse(input);
  },

  create(input: Pane): Pane {
    return Pane.validate(input);
  },

  update(entity: Pane, input: PaneUpdateInput): Pane {
    const current = Pane.validate(entity);
    return Pane.validate(applyObjectPatch(current, input));
  },

  canTransitionState: canTransitionPaneState,
  transitionState: transitionPaneState,
  isAttentionState,
  kindForCommand,
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
  at = new Date().toISOString(),
): PaneStateTransition {
  if (!canTransitionPaneState(current, next)) {
    throw new Error(`Invalid pane state transition: ${current} -> ${next}`);
  }
  return { from: current, to: next, reason, at };
}

export function isAttentionState(state: PaneState): boolean {
  paneStateSchema.parse(state);
  return state === "waiting_input" || state === "waiting_approval" || state === "failed";
}

export function kindForCommand(command: string): PaneKind {
  const executable = command.trim().toLowerCase().split(/\s+/, 1)[0]?.split("/").at(-1) ?? "";
  if (!executable || executable === "zsh" || executable === "bash" || executable === "fish" || executable === "sh") {
    return "shell";
  }
  if (["agent", "codex", "claude", "aider", "opencode", "gemini"].includes(executable)) return "agent";
  return "unknown";
}
