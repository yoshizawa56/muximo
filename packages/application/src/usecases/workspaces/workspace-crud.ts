import { clearPatch, type Patch, Workspace, type WorkspaceRecord, WorkspaceUpdateEmptyError } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { TransactionManager } from "../../ports/transactions.js";
import type { WorkspaceAuditPort, WorkspaceDirectoryInfo, WorkspaceDirectoryPort } from "../../ports/workspace.js";
import type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./workspace-inputs.js";

export class WorkspaceUseCaseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceUseCaseError";
  }
}

export class WorkspaceAlreadyRegisteredError extends WorkspaceUseCaseError {
  public constructor(workspace: WorkspaceDirectoryInfo) {
    super("workspace_already_registered", `workspace is already registered: ${workspace.rootPath}`, {
      workspaceId: workspace.id,
      directory: workspace.rootPath,
    });
    this.name = "WorkspaceAlreadyRegisteredError";
  }
}

export class WorkspaceNotFoundError extends WorkspaceUseCaseError {
  public constructor(selector: string) {
    super("workspace_not_found", `workspace not found: ${selector}`, { selector });
    this.name = "WorkspaceNotFoundError";
  }
}

export { InvalidWorkspaceCopyPatternError, InvalidWorkspaceNameError, WorkspaceUpdateEmptyError } from "@muximo/domain";

export class WorkspaceRecordFactory {
  public constructor(
    private readonly directories: WorkspaceDirectoryPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async create(input: RegisterWorkspaceInput, existing?: WorkspaceRecord): Promise<WorkspaceRecord> {
    const directory = await this.directories.resolveDirectory(input.directory);
    const now = this.now();
    const setupScriptPath = await this.resolveCreateHook(input.setupHook, directory.rootPath);
    const cleanupScriptPath = await this.resolveCreateHook(input.cleanupHook, directory.rootPath);
    return Workspace.create({
      id: directory.id,
      rootPath: directory.rootPath,
      name: input.name ?? existing?.name ?? directory.name,
      isGit: directory.isGit,
      ...(setupScriptPath !== undefined ? { setupScriptPath } : {}),
      ...(cleanupScriptPath !== undefined ? { cleanupScriptPath } : {}),
      worktreeCopyPatterns: input.worktreeCopyPatterns ?? existing?.worktreeCopyPatterns ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  public async update(existing: WorkspaceRecord, input: UpdateWorkspaceInput): Promise<WorkspaceRecord> {
    const setupHook = await this.resolveHookPatch(input.setupHook, existing.rootPath);
    const cleanupHook = await this.resolveHookPatch(input.cleanupHook, existing.rootPath);
    return Workspace.update(existing, {
      name: input.name,
      setupScriptPath: setupHook,
      cleanupScriptPath: cleanupHook,
      worktreeCopyPatterns: input.worktreeCopyPatterns,
      appendWorktreeCopyPatterns: input.appendCopyPatterns,
      clearWorktreeCopyPatterns: input.clearCopyPatterns,
    });
  }

  private async resolveCreateHook(input: Patch<string>, rootPath: string): Promise<string | undefined> {
    if (typeof input !== "string") return undefined;
    return this.directories.resolveHook(input, rootPath);
  }

  private async resolveHookPatch(input: Patch<string>, rootPath: string): Promise<Patch<string>> {
    if (input === undefined) return undefined;
    if (input === clearPatch) return clearPatch;
    if (typeof input === "string") return this.directories.resolveHook(input, rootPath);
    return undefined;
  }
}

export class ListWorkspaces {
  public constructor(private readonly workspaces: WorkspaceRepository) {}

  public execute(): Promise<WorkspaceRecord[]> {
    return this.workspaces.list();
  }
}

export class RegisterWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly factory: WorkspaceRecordFactory,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> {
    const candidate = await this.factory.create(input);
    return withTransaction(this.transactionManager, async () => {
      if (!(await this.workspaces.insert(candidate))) {
        throw new WorkspaceAlreadyRegisteredError({
          id: candidate.id,
          rootPath: candidate.rootPath,
          name: candidate.name,
          isGit: candidate.isGit,
        });
      }
      await this.workspaces.upsert(candidate);
      await this.audit?.record("workspace.created", candidate.id, {
        name: candidate.name,
        directory: candidate.rootPath,
      });
      return candidate;
    });
  }
}

export class UpdateWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly directories: WorkspaceDirectoryPort,
    private readonly factory: WorkspaceRecordFactory,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(selector: string, input: UpdateWorkspaceInput): Promise<WorkspaceRecord> {
    if (!hasWorkspaceUpdate(input)) throw new WorkspaceUpdateEmptyError();
    const existing = await findWorkspace(this.workspaces, this.directories, selector);
    const workspace = await this.factory.update(existing, input);
    return withTransaction(this.transactionManager, async () => {
      await this.workspaces.upsert(workspace);
      await this.audit?.record("workspace.updated", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    });
  }
}

export class DeleteWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly directories: WorkspaceDirectoryPort,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(selector: string): Promise<WorkspaceRecord> {
    const workspace = await findWorkspace(this.workspaces, this.directories, selector);
    return withTransaction(this.transactionManager, async () => {
      await this.workspaces.delete(workspace.id);
      await this.audit?.record("workspace.deleted", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    });
  }
}

export class WorkspaceCrud {
  public readonly list: ListWorkspaces;
  public readonly register: RegisterWorkspace;
  public readonly update: UpdateWorkspace;
  public readonly delete: DeleteWorkspace;

  public constructor(
    workspaces: WorkspaceRepository,
    directories: WorkspaceDirectoryPort,
    options: { audit?: WorkspaceAuditPort; now?: () => string; transactionManager?: TransactionManager } = {},
  ) {
    const factory = new WorkspaceRecordFactory(directories, options.now);
    this.list = new ListWorkspaces(workspaces);
    this.register = new RegisterWorkspace(workspaces, factory, options.audit, options.transactionManager);
    this.update = new UpdateWorkspace(workspaces, directories, factory, options.audit, options.transactionManager);
    this.delete = new DeleteWorkspace(workspaces, directories, options.audit, options.transactionManager);
  }
}

function withTransaction<Result>(
  transactionManager: TransactionManager | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  return transactionManager ? transactionManager.run(operation) : operation();
}

function hasWorkspaceUpdate(input: UpdateWorkspaceInput): boolean {
  return (
    input.name !== undefined ||
    input.setupHook !== undefined ||
    input.cleanupHook !== undefined ||
    input.worktreeCopyPatterns !== undefined ||
    (input.appendCopyPatterns?.length ?? 0) > 0 ||
    input.clearCopyPatterns === true
  );
}

async function findWorkspace(
  workspaces: WorkspaceRepository,
  directories: WorkspaceDirectoryPort,
  selector: string,
): Promise<WorkspaceRecord> {
  const reference = selector.trim();
  if (!reference) throw new WorkspaceNotFoundError(selector);
  const records = await workspaces.list();
  const byId = records.find((workspace) => workspace.id === reference);
  if (byId) return byId;

  let resolved: WorkspaceDirectoryInfo | undefined;
  try {
    resolved = await directories.resolveDirectory(reference);
  } catch {
    // A selector is commonly a workspace name. Directory resolution is only
    // a fallback for path selectors, so expected path failures are ignored.
  }
  if (resolved) {
    const byPath = records.find(
      (workspace) => workspace.id === resolved?.id || workspace.rootPath === resolved?.rootPath,
    );
    if (byPath) return byPath;
  }

  const byName = records.filter((workspace) => workspace.name === reference);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new WorkspaceUseCaseError(
      "workspace_name_ambiguous",
      `workspace name is ambiguous; use its ID: ${reference}`,
      { selector: reference },
    );
  }
  throw new WorkspaceNotFoundError(reference);
}
