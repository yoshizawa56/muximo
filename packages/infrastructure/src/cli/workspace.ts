import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  ManagedAgentSessionRepository,
  SessionNamingPort,
  WorkspaceRepository,
  WorkspaceResolverPort,
} from "@muximo/application";
import { type AgentBackend, Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import { isPathWithin, localTimestamp, realpathSafe, timestamp } from "./filesystem.js";
import { gitWorkspaceRoot } from "./git.js";

export type WorkspaceResolverOptions = {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  workspaces: WorkspaceRepository;
};

/** Resolves the current workspace from CLI selection, Git, and registrations. */
export class WorkspaceResolverAdapter implements WorkspaceResolverPort {
  private readonly cwd: string;

  public constructor(private readonly options: WorkspaceResolverOptions) {
    this.cwd = realpathSafe(options.cwd);
  }

  public async resolveCurrent(): Promise<WorkspaceRecord> {
    const selectedWorkspaceId = this.options.environment.MUXIMOD_WORKSPACE_ID?.trim();
    if (selectedWorkspaceId) {
      const selected = await this.options.workspaces.findById(WorkspaceId.create(selectedWorkspaceId));
      if (selected) return selected;
    }

    const gitRoot = gitWorkspaceRoot(this.cwd);
    const root = gitRoot ?? this.cwd;
    const id = workspaceIdForPath(root);
    const existing = (await this.options.workspaces.findById(id)) ?? (await this.findRegisteredWorkspaceForCwd(root));
    if (existing) return existing;

    const now = timestamp();
    return Workspace.create({
      id,
      rootPath: root,
      name: basename(root),
      isGit: Boolean(gitRoot),
      worktreeCopyPatterns: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  private async findRegisteredWorkspaceForCwd(gitRoot: string): Promise<WorkspaceRecord | undefined> {
    if (this.cwd === gitRoot) return undefined;
    const candidates = (await this.options.workspaces.list())
      .filter((workspace) => workspace.rootPath !== gitRoot)
      .filter((workspace) => isPathWithin(gitRoot, workspace.rootPath) && isPathWithin(workspace.rootPath, this.cwd))
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
