import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type {
  ManagedAgentSessionRepository,
  SessionNamingPort,
  WorkspaceDirectoryPort,
  WorkspaceRepository,
  WorkspaceResolutionInput,
  WorkspaceResolverPort,
} from "@muximo/application";
import { type AgentBackend, Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import { isPathWithin, localTimestamp, realpathSafe, timestamp } from "./filesystem.js";
import { gitWorkspaceRoot } from "./git.js";

export type WorkspaceResolverOptions = {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  workspaces: WorkspaceRepository;
  directory?: WorkspaceDirectoryPort;
};

/** Resolves the current workspace from CLI selection, Git, and registrations. */
export class WorkspaceResolverAdapter implements WorkspaceResolverPort {
  private readonly cwd: string;

  public constructor(private readonly options: WorkspaceResolverOptions) {
    this.cwd = realpathSafe(options.cwd);
  }

  public async resolveCurrent(input: WorkspaceResolutionInput = {}): Promise<WorkspaceRecord> {
    const workspaceSelector = input.workspace?.trim();
    if (workspaceSelector) return this.resolveExplicit(workspaceSelector, input.cwd ?? this.cwd);

    const cwd = await this.resolveCwd(input.cwd);

    const selectedWorkspaceId = this.options.environment.MUXIMOD_WORKSPACE_ID?.trim();
    if (selectedWorkspaceId) {
      const selected = await this.options.workspaces.findById(WorkspaceId.create(selectedWorkspaceId));
      if (selected) return selected;
    }

    const gitRoot = gitWorkspaceRoot(cwd);
    const root = gitRoot ?? cwd;
    const id = workspaceIdForPath(root);
    const existing =
      (await this.options.workspaces.findById(id)) ?? (await this.findRegisteredWorkspaceForCwd(gitRoot, cwd));
    if (existing) return existing;

    const now = timestamp();
    return Workspace.create({
      id,
      rootPath: root,
      name: basename(root),
      isGit: Boolean(gitRoot),
      createdAt: now,
      updatedAt: now,
    });
  }

  private async resolveCwd(cwd: string | undefined): Promise<string> {
    const resolved = realpathSafe(cwd ?? this.cwd);
    await this.options.directory?.resolveDirectory(resolved);
    return resolved;
  }

  private async resolveExplicit(selector: string, cwd: string): Promise<WorkspaceRecord> {
    const records = await this.options.workspaces.list();
    const named = records.filter((workspace) => workspace.name === selector);
    if (named.length > 1) throw new Error(`workspace name is ambiguous; select its path: ${selector}`);
    const [namedWorkspace] = named;
    if (namedWorkspace) return namedWorkspace;

    const candidate = resolveWorkspacePath(selector, cwd);
    let resolvedRoot: string | undefined;
    try {
      resolvedRoot = (await this.options.directory?.resolveDirectory(candidate))?.rootPath;
    } catch (error) {
      if (!isMissingDirectoryError(error)) throw error;
    }
    resolvedRoot ??= gitWorkspaceRoot(candidate) ?? realpathSafe(candidate);
    const matches = records.filter((workspace) => samePath(workspace.rootPath, resolvedRoot));
    const [workspace] = matches;
    if (matches.length === 1 && workspace) return workspace;
    throw new Error(`workspace not found: ${selector}`);
  }

  private async findRegisteredWorkspaceForCwd(
    repositoryRoot: string | undefined,
    cwd: string,
  ): Promise<WorkspaceRecord | undefined> {
    if (repositoryRoot && cwd === repositoryRoot) return undefined;
    const candidates = (await this.options.workspaces.list())
      .filter((workspace) => !repositoryRoot || workspace.rootPath !== repositoryRoot)
      .filter(
        (workspace) =>
          (!repositoryRoot || isPathWithin(repositoryRoot, workspace.rootPath)) &&
          isPathWithin(workspace.rootPath, cwd),
      )
      .sort((left, right) => right.rootPath.length - left.rootPath.length);
    return candidates[0];
  }
}

/** Generates deterministic, collision-free names for a backend/workspace pair. */
export class SessionNamingAdapter implements SessionNamingPort {
  public constructor(private readonly sessions: ManagedAgentSessionRepository) {}

  public async resolveName(
    workspaceId: WorkspaceId,
    requestedName: string | undefined,
    backend: AgentBackend,
  ): Promise<string> {
    if (requestedName !== undefined) return requestedName;
    const prefix = `${backend}-${localTimestamp()}`;
    let candidate = prefix;
    let suffix = 0;
    while (await this.sessions.findByName(workspaceId, candidate)) {
      suffix += 1;
      candidate = `${prefix}-${suffix}`;
    }
    return candidate;
  }
}

function workspaceIdForPath(path: string): WorkspaceId {
  return WorkspaceId.create(createHash("sha256").update(path).digest("hex").slice(0, 16));
}

function resolveWorkspacePath(selector: string, cwd: string): string {
  if (selector === "~") return homedir();
  if (selector.startsWith("~/")) return resolve(homedir(), selector.slice(2));
  return resolve(cwd, selector);
}

function samePath(left: string, right: string): boolean {
  return realpathSafe(left) === realpathSafe(right);
}

function isMissingDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("reason" in error)) return false;
  const reason = (error as { reason?: unknown }).reason;
  return reason === "not_found" || reason === "not_directory";
}
