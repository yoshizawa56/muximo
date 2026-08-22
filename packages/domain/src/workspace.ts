import { z } from "zod";
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from "./ids.js";
import { applyPatch, type Patch } from "./patch.js";

export const worktreeCopyPatternLimits = {
  maxPatterns: 100,
  maxPatternLength: 4_096,
} as const;

const workspaceNameMaxLength = 120;

export class InvalidWorkspaceNameError extends Error {
  public readonly code = "invalid_workspace_name" as const;

  public constructor(public readonly value: string) {
    super(invalidWorkspaceNameMessage(value));
    this.name = "InvalidWorkspaceNameError";
  }

  public get details(): Record<string, unknown> {
    return { name: this.value };
  }
}

export class InvalidWorkspaceCopyPatternError extends Error {
  public readonly code = "invalid_copy_pattern" as const;

  public constructor(public readonly pattern: string) {
    super(`Invalid worktree copy pattern: ${pattern}`);
    this.name = "InvalidWorkspaceCopyPatternError";
  }

  public get details(): Record<string, unknown> {
    return { pattern: this.pattern };
  }
}

export const workspaceSelectionModes = ["workspace", "worktree"] as const;
export const workspaceSelectionModeSchema = z.enum(workspaceSelectionModes);
export type WorkspaceSelectionMode = z.infer<typeof workspaceSelectionModeSchema>;

const workspaceNameSchema = z.string().min(1).max(workspaceNameMaxLength).refine(
  (value) => !/[\u0000\r\n\t]/.test(value),
  "workspace name contains a control character",
);
const workspacePathSchema = z.string().min(1);
const worktreeCopyPatternSchema = z.string().min(1).max(worktreeCopyPatternLimits.maxPatternLength).refine(
  isValidWorktreeCopyPattern,
  "invalid worktree copy pattern",
);

const workspaceSchema = z.object({
  id: WorkspaceId.schema,
  rootPath: workspacePathSchema,
  name: workspaceNameSchema,
  isGit: z.boolean(),
  setupScriptPath: workspacePathSchema.optional(),
  cleanupScriptPath: workspacePathSchema.optional(),
  worktreeCopyPatterns: z.array(worktreeCopyPatternSchema).max(worktreeCopyPatternLimits.maxPatterns),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceRecord = Workspace;

export type WorkspaceCreateInput = {
  id: WorkspaceIdType;
  rootPath: string;
  name: string;
  isGit: boolean;
  setupScriptPath?: string;
  cleanupScriptPath?: string;
  worktreeCopyPatterns?: readonly string[];
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceUpdateInput = {
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
  worktreeCopyPatterns?: readonly string[];
  appendWorktreeCopyPatterns?: readonly string[];
  clearWorktreeCopyPatterns?: boolean;
};

export const Workspace = {
  schema: workspaceSchema,

  validate(input: unknown): Workspace {
    return workspaceSchema.parse(input);
  },

  create(input: WorkspaceCreateInput): Workspace {
    return Workspace.validate({
      ...input,
      name: validateWorkspaceName(input.name),
      worktreeCopyPatterns: validateWorktreeCopyPatterns(input.worktreeCopyPatterns ?? []),
    });
  },

  update(entity: Workspace, input: WorkspaceUpdateInput): Workspace {
    const current = Workspace.validate(entity);
    if (!hasWorkspaceUpdate(input)) throw new WorkspaceUpdateEmptyError();
    if (input.worktreeCopyPatterns !== undefined && input.clearWorktreeCopyPatterns) {
      throw new WorkspaceUpdateConflictError("cannot clear and replace worktree copy patterns in the same update");
    }

    let patterns = input.worktreeCopyPatterns === undefined
      ? [...current.worktreeCopyPatterns]
      : [...input.worktreeCopyPatterns];
    if (input.clearWorktreeCopyPatterns) patterns = [];
    patterns = normalizeWorktreeCopyPatterns([...patterns, ...(input.appendWorktreeCopyPatterns ?? [])]);

    return Workspace.validate({
      ...current,
      name: input.name === undefined ? current.name : validateWorkspaceName(input.name),
      setupScriptPath: applyPatch(current.setupScriptPath, input.setupScriptPath),
      cleanupScriptPath: applyPatch(current.cleanupScriptPath, input.cleanupScriptPath),
      worktreeCopyPatterns: validateWorktreeCopyPatterns(patterns),
    });
  },

  validateName: validateWorkspaceName,
  validateCopyPatterns: validateWorktreeCopyPatterns,
  isValidCopyPattern: isValidWorktreeCopyPattern,
  normalizeCopyPatterns: normalizeWorktreeCopyPatterns,
  selection: validateWorkspaceSelection,
} as const;

export class WorkspaceUpdateEmptyError extends Error {
  public readonly code = "workspace_update_empty" as const;

  public constructor() {
    super("workspace update requires at least one field to change");
    this.name = "WorkspaceUpdateEmptyError";
  }
}

export class WorkspaceUpdateConflictError extends Error {
  public readonly code = "workspace_copy_pattern_conflict" as const;

  public constructor(message: string) {
    super(message);
    this.name = "WorkspaceUpdateConflictError";
  }
}

export type WorkspaceDirectoryOption = Pick<
  Workspace,
  "id" | "name" | "rootPath" | "isGit" | "setupScriptPath" | "cleanupScriptPath" | "worktreeCopyPatterns"
>;

export type WorkspaceSelection = {
  workspaceId: WorkspaceIdType;
  mode: WorkspaceSelectionMode;
};

export type WorkspaceSelectionErrorCode =
  | "workspace_not_found"
  | "worktree_not_supported";

export class WorkspaceSelectionError extends Error {
  public constructor(
    public readonly code: WorkspaceSelectionErrorCode,
    message: string,
    public readonly details: { workspaceId: WorkspaceIdType },
  ) {
    super(message);
    this.name = "WorkspaceSelectionError";
  }
}

export function validateWorkspaceSelection(
  selection: WorkspaceSelection,
  workspace: WorkspaceDirectoryOption | undefined,
): WorkspaceSelection {
  const checkedSelection = {
    ...selection,
    workspaceId: WorkspaceId.schema.parse(selection.workspaceId),
  };
  if (!workspace) {
    throw new WorkspaceSelectionError(
      "workspace_not_found",
      `Workspace directory not found: ${checkedSelection.workspaceId}`,
      { workspaceId: checkedSelection.workspaceId },
    );
  }
  if (checkedSelection.mode === "worktree" && !workspace.isGit) {
    throw new WorkspaceSelectionError(
      "worktree_not_supported",
      `Workspace does not support worktrees: ${workspace.rootPath}`,
      { workspaceId: checkedSelection.workspaceId },
    );
  }
  return checkedSelection;
}

export function validateWorkspaceName(value: string): string {
  const name = value.trim();
  if (!name || name.length > workspaceNameMaxLength || /[\u0000\r\n\t]/.test(name)) {
    throw new InvalidWorkspaceNameError(value);
  }
  return name;
}

export function isValidWorktreeCopyPattern(value: string): boolean {
  const pattern = value.trim();
  if (!pattern || pattern.length > worktreeCopyPatternLimits.maxPatternLength) return false;
  if (pattern.includes("\\") || pattern.includes("\u0000")) return false;
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return false;
  return pattern.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function normalizeWorktreeCopyPatterns(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function validateWorktreeCopyPatterns(values: readonly string[]): string[] {
  const normalized = normalizeWorktreeCopyPatterns(values);
  if (normalized.length > worktreeCopyPatternLimits.maxPatterns) {
    throw new InvalidWorkspaceCopyPatternError(`too many patterns (maximum ${worktreeCopyPatternLimits.maxPatterns})`);
  }
  for (const pattern of normalized) {
    if (!isValidWorktreeCopyPattern(pattern)) throw new InvalidWorkspaceCopyPatternError(pattern);
  }
  return normalized;
}

function hasWorkspaceUpdate(input: WorkspaceUpdateInput): boolean {
  return input.name !== undefined
    || input.setupScriptPath !== undefined
    || input.cleanupScriptPath !== undefined
    || input.worktreeCopyPatterns !== undefined
    || (input.appendWorktreeCopyPatterns?.length ?? 0) > 0
    || input.clearWorktreeCopyPatterns === true;
}

function invalidWorkspaceNameMessage(value: string): string {
  const name = value.trim();
  if (!name) return "workspace name cannot be empty";
  if (name.length > workspaceNameMaxLength) return "workspace name cannot exceed 120 characters";
  return "workspace name cannot contain control characters";
}
