import { Schema } from "effect";
import { InvalidEntityError } from "./entity-errors.js";
import { WorkspaceId, type WorkspaceId as WorkspaceIdType } from "./ids.js";
import { applyPatch, type EntityPatch } from "./patch.js";

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
export const workspaceSelectionModeSchema = Schema.Literals(workspaceSelectionModes);
export type WorkspaceSelectionMode = (typeof workspaceSelectionModeSchema)["Type"];

const workspaceNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(workspaceNameMaxLength),
  Schema.isPattern(/^[^\u0000\r\n\t]*$/),
);
const workspacePathSchema = Schema.String.check(Schema.isMinLength(1));

/** Bare field schemas shared by the entity definition and wire derivations. */
export const WorkspaceFields = {
  id: WorkspaceId.schema,
  rootPath: workspacePathSchema,
  name: workspaceNameSchema,
  isGit: Schema.Boolean,
  setupScriptPath: workspacePathSchema,
  cleanupScriptPath: workspacePathSchema,
} as const;

export type WorkspaceCreateInput = {
  id: WorkspaceIdType;
  rootPath: string;
  name: string;
  isGit: boolean;
  setupScriptPath?: string;
  cleanupScriptPath?: string;
};

const workspaceImmutableFields = ["id", "rootPath", "isGit"] as const;
type WorkspaceImmutableFields = (typeof workspaceImmutableFields)[number];
export type WorkspaceUpdateInput = EntityPatch<(typeof Workspace)["Encoded"], WorkspaceImmutableFields>;

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  id: WorkspaceId.schema,
  rootPath: workspacePathSchema,
  name: workspaceNameSchema,
  isGit: Schema.Boolean,
  setupScriptPath: Schema.optional(workspacePathSchema),
  cleanupScriptPath: Schema.optional(workspacePathSchema),
}) {
  static create(input: WorkspaceCreateInput): Workspace {
    return decodeWorkspace({
      ...input,
      name: validateWorkspaceName(input.name),
    });
  }

  /** Rehydrates a persisted workspace. This is the only re-entry point for raw data. */
  static restore(input: unknown): Workspace {
    return decodeWorkspace(input);
  }

  update(input: WorkspaceUpdateInput): Workspace {
    for (const key of Object.keys(input)) {
      if (immutableWorkspaceUpdateKeys.has(key)) {
        throw new Error(`Workspace update cannot change immutable field: ${key}`);
      }
    }
    if (!hasWorkspaceUpdate(input)) throw new WorkspaceUpdateEmptyError();
    return decodeWorkspace({
      ...this,
      name: input.name === undefined ? this.name : validateWorkspaceName(input.name),
      setupScriptPath: applyPatch(this.setupScriptPath, input.setupScriptPath),
      cleanupScriptPath: applyPatch(this.cleanupScriptPath, input.cleanupScriptPath),
    });
  }

  static validateName = validateWorkspaceName;
  static selection = validateWorkspaceSelection;
}

const decodeWorkspace = (input: unknown): Workspace => {
  try {
    return Schema.decodeUnknownSync(Workspace, { onExcessProperty: "error" })(input);
  } catch (error) {
    throw new InvalidEntityError("Workspace", { cause: error });
  }
};

const immutableWorkspaceUpdateKeys = new Set<string>(workspaceImmutableFields);

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
    workspaceId: WorkspaceId.create(selection.workspaceId),
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
  return input.name !== undefined || input.setupScriptPath !== undefined || input.cleanupScriptPath !== undefined;
}

function invalidWorkspaceNameMessage(value: string): string {
  const name = value.trim();
  if (!name) return "workspace name cannot be empty";
  if (name.length > workspaceNameMaxLength) return "workspace name cannot exceed 120 characters";
  return "workspace name cannot contain control characters";
}
