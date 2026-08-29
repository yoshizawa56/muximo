import { z } from "zod";
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from "./ids.js";
import { applyPatch, type Patch } from "./patch.js";

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

export const workspaceSelectionModes = ["workspace", "worktree"] as const;
export const workspaceSelectionModeSchema = z.enum(workspaceSelectionModes);
export type WorkspaceSelectionMode = z.infer<typeof workspaceSelectionModeSchema>;

const workspaceNameSchema = z
  .string()
  .min(1)
  .max(workspaceNameMaxLength)
  .refine((value) => !/[\u0000\r\n\t]/.test(value), "workspace name contains a control character");
const workspacePathSchema = z.string().min(1);
const workspaceSchema = z
  .object({
    id: WorkspaceId.schema,
    rootPath: workspacePathSchema,
    name: workspaceNameSchema,
    isGit: z.boolean(),
    setupScriptPath: workspacePathSchema.optional(),
    cleanupScriptPath: workspacePathSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceRecord = Workspace;

export type WorkspaceCreateInput = {
  id: WorkspaceIdType;
  rootPath: string;
  name: string;
  isGit: boolean;
  setupScriptPath?: string;
  cleanupScriptPath?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceUpdateInput = {
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
  updatedAt?: string;
};
const parseWorkspace = (input: unknown): Workspace => workspaceSchema.parse(input);

export const Workspace = {
  schema: workspaceSchema,

  /** Rehydrates a persisted workspace. This is the only re-entry point for raw data. */
  restore(input: unknown): Workspace {
    return parseWorkspace(input);
  },

  create(input: WorkspaceCreateInput): Workspace {
    return parseWorkspace({
      ...input,
      name: validateWorkspaceName(input.name),
    });
  },

  update(entity: Workspace, input: WorkspaceUpdateInput): Workspace {
    const current = parseWorkspace(entity);
    if (!hasWorkspaceUpdate(input)) throw new WorkspaceUpdateEmptyError();

    return parseWorkspace({
      ...current,
      name: input.name === undefined ? current.name : validateWorkspaceName(input.name),
      setupScriptPath: applyPatch(current.setupScriptPath, input.setupScriptPath),
      cleanupScriptPath: applyPatch(current.cleanupScriptPath, input.cleanupScriptPath),
      updatedAt: input.updatedAt === undefined ? current.updatedAt : input.updatedAt,
    });
  },

  validateName: validateWorkspaceName,
  selection: validateWorkspaceSelection,
} as const;

export class WorkspaceUpdateEmptyError extends Error {
  public readonly code = "workspace_update_empty" as const;

  public constructor() {
    super("workspace update requires at least one field to change");
    this.name = "WorkspaceUpdateEmptyError";
  }
}

export type WorkspaceDirectoryOption = Pick<
  Workspace,
  "id" | "name" | "rootPath" | "isGit" | "setupScriptPath" | "cleanupScriptPath"
>;

export type WorkspaceSelection = {
  workspaceId: WorkspaceIdType;
  mode: WorkspaceSelectionMode;
};

export type WorkspaceSelectionErrorCode = "workspace_not_found" | "worktree_not_supported";

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

function hasWorkspaceUpdate(input: WorkspaceUpdateInput): boolean {
  return (
    input.name !== undefined ||
    input.setupScriptPath !== undefined ||
    input.cleanupScriptPath !== undefined ||
    input.updatedAt !== undefined
  );
}

function invalidWorkspaceNameMessage(value: string): string {
  const name = value.trim();
  if (!name) return "workspace name cannot be empty";
  if (name.length > workspaceNameMaxLength) return "workspace name cannot exceed 120 characters";
  return "workspace name cannot contain control characters";
}
