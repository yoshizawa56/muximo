import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type {
  ApplicationEffect,
  ManagedAgentSessionRepository,
  SessionNamingPort,
  WorkspaceDirectoryPort,
  WorkspaceRepository,
  WorkspaceResolutionInput,
  WorkspaceResolverPort,
} from "@muximo/application";
import { type AgentBackend, Workspace, WorkspaceId } from "@muximo/domain";
import { Effect } from "effect";
import { isPathWithin, localTimestamp, realpathSafe } from "./filesystem.js";
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

  public resolveCurrent(input: WorkspaceResolutionInput = {}): ApplicationEffect<Workspace> {
    const self = this;
    return Effect.gen(function* () {
      const workspaceSelector = input.workspace?.trim();
      if (workspaceSelector) return yield* self.resolveExplicit(workspaceSelector, input.cwd ?? self.cwd);

      const selectedWorkspaceId = self.options.environment.MUXIMOD_WORKSPACE_ID?.trim();
      if (selectedWorkspaceId) {
        const selected = yield* self.options.workspaces.findById(WorkspaceId.create(selectedWorkspaceId));
        if (selected) return selected;
      }

      const cwd = yield* self.resolveCwd(input.cwd);

      const gitRoot = gitWorkspaceRoot(cwd);
      const root = gitRoot ?? cwd;
      const id = workspaceIdForPath(root);
      const existing =
        (yield* self.options.workspaces.findById(id)) ?? (yield* self.findRegisteredWorkspaceForCwd(gitRoot, cwd));
      if (existing) return existing;

      return Workspace.create({
        id,
        rootPath: root,
        name: basename(root),
        isGit: Boolean(gitRoot),
      });
    });
  }

  private resolveCwd(cwd: string | undefined): ApplicationEffect<string> {
    const resolved = realpathSafe(cwd ?? this.cwd);
    if (!this.options.directory) return Effect.succeed(resolved);
    return this.options.directory.resolveDirectory(resolved).pipe(Effect.as(resolved));
  }

  private resolveExplicit(selector: string, cwd: string): ApplicationEffect<Workspace> {
    const self = this;
    return Effect.gen(function* () {
      const records = yield* self.options.workspaces.list();
      const named = records.filter((workspace) => workspace.name === selector);
      if (named.length > 1)
        return yield* Effect.fail(new Error(`workspace name is ambiguous; select its path: ${selector}`));
      const [namedWorkspace] = named;
      if (namedWorkspace) {
        if (self.options.directory) {
          yield* self.options.directory.resolveDirectory(namedWorkspace.rootPath);
        }
        return namedWorkspace;
      }

      const candidate = resolveWorkspacePath(selector, cwd);
      const resolvedRoot = self.options.directory
        ? yield* self.options.directory.resolveDirectory(candidate).pipe(
            Effect.map((directory) => directory.rootPath),
            Effect.catch((error) => {
              if (!isMissingDirectoryError(error)) return Effect.fail(error);
              return Effect.succeed(undefined);
            }),
          )
        : undefined;
      const root = resolvedRoot ?? gitWorkspaceRoot(candidate) ?? realpathSafe(candidate);
      const matches = records.filter((workspace) => samePath(workspace.rootPath, root));
      const [workspace] = matches;
      if (matches.length === 1 && workspace) return workspace;
      return yield* Effect.fail(new Error(`workspace not found: ${selector}`));
    });
  }

  private findRegisteredWorkspaceForCwd(
    repositoryRoot: string | undefined,
    cwd: string,
  ): ApplicationEffect<Workspace | undefined> {
    if (repositoryRoot && cwd === repositoryRoot) return Effect.succeed(undefined);
    return this.options.workspaces.list().pipe(
      Effect.map(
        (records) =>
          records
            .filter((workspace) => !repositoryRoot || workspace.rootPath !== repositoryRoot)
            .filter(
              (workspace) =>
                (!repositoryRoot || isPathWithin(repositoryRoot, workspace.rootPath)) &&
                isPathWithin(workspace.rootPath, cwd),
            )
            .sort((left, right) => right.rootPath.length - left.rootPath.length)[0],
      ),
    );
  }
}

/** Generates deterministic, collision-free names for a backend/workspace pair. */
export class SessionNamingAdapter implements SessionNamingPort {
  public constructor(private readonly sessions: ManagedAgentSessionRepository) {}

  public resolveName(
    workspaceId: WorkspaceId,
    requestedName: string | undefined,
    backend: AgentBackend,
  ): ApplicationEffect<string> {
    if (requestedName !== undefined) return Effect.succeed(requestedName);
    const self = this;
    return Effect.gen(function* () {
      const prefix = `${backend}-${localTimestamp()}`;
      let candidate = prefix;
      let suffix = 0;
      while (yield* self.sessions.findByName(workspaceId, candidate)) {
        suffix += 1;
        candidate = `${prefix}-${suffix}`;
      }
      return candidate;
    });
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
