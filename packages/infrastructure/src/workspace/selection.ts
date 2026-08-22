// Filesystem and Git workspace discovery is the workspace infrastructure adapter.
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, relative, resolve } from "node:path";
import type { MuximodWorkspaceDirectory, WorkspaceDirectoryInfo, WorkspaceDirectoryPort } from "@muximo/application";
import {
  Workspace,
  WorkspaceId,
  validateWorktreeCopyPatterns as validateDomainWorktreeCopyPatterns,
  validateWorkspaceSelection,
  type WorkspaceDirectoryOption,
  type WorkspaceRecord,
  type WorkspaceSelection,
} from "@muximo/domain";

export type InvalidDirectoryReason = "not_found" | "not_directory" | "outside_allowed_root" | "unknown_workspace";
export type InvalidHookReason = "not_found" | "not_file" | "not_executable";

export class InvalidWorkspaceDirectoryError extends Error {
  public readonly code = "invalid_directory" as const;

  public constructor(
    public readonly directory: string,
    public readonly reason: InvalidDirectoryReason,
    public readonly allowedRoots: string[],
  ) {
    super(invalidDirectoryMessage(directory, reason));
    this.name = "InvalidWorkspaceDirectoryError";
  }

  public get details(): Record<string, unknown> {
    return { directory: this.directory, reason: this.reason, allowedRoots: this.allowedRoots };
  }
}

export class InvalidWorkspaceHookError extends Error {
  public readonly code = "invalid_hook" as const;

  public constructor(public readonly path: string, public readonly reason: InvalidHookReason) {
    super(invalidHookMessage(path, reason));
    this.name = "InvalidWorkspaceHookError";
  }

  public get details(): Record<string, unknown> {
    return { path: this.path, reason: this.reason };
  }
}

/** The host-side directory boundary used by workspace registration and lookup. */
export class AllowedRootPolicy {
  public readonly roots: string[];

  public constructor(roots: readonly string[], private readonly basePath = process.cwd()) {
    this.roots = unique(roots.map((root) => expandPath(root, this.basePath)).map((root) => realpathIfPresent(root)));
  }

  public contains(directory: string): boolean {
    const candidate = realpathIfPresent(expandPath(directory, this.basePath));
    return this.roots.some((root) => isPathWithin(root, candidate));
  }

  public assertDirectory(directory: string): string {
    const expanded = expandPath(directory, this.basePath);
    if (!existsSync(expanded)) throw new InvalidWorkspaceDirectoryError(directory, "not_found", this.roots);
    if (!statSync(expanded).isDirectory()) throw new InvalidWorkspaceDirectoryError(directory, "not_directory", this.roots);

    const realPath = realpathSync(expanded);
    if (!this.roots.some((root) => isPathWithin(root, realPath))) {
      throw new InvalidWorkspaceDirectoryError(directory, "outside_allowed_root", this.roots);
    }
    return realPath;
  }
}

export class WorkspaceSelectionCatalog implements WorkspaceDirectoryPort {
  public readonly policy: AllowedRootPolicy;

  public constructor(allowedRoots: readonly string[], basePath = process.cwd()) {
    this.policy = new AllowedRootPolicy(allowedRoots, basePath);
  }

  public resolveDirectory(directory: string): WorkspaceDirectoryInfo {
    const resolved = this.policy.assertDirectory(directory);
    const rootPath = gitWorkspaceRoot(resolved) ?? resolved;
    if (!this.policy.contains(rootPath)) {
      throw new InvalidWorkspaceDirectoryError(directory, "outside_allowed_root", this.policy.roots);
    }
    return {
      id: workspaceIdForPath(rootPath),
      rootPath,
      name: basename(rootPath) || rootPath,
      isGit: rootPath !== resolved || isGitWorkspace(rootPath),
    };
  }

  public resolveHook(path: string, workspaceRoot: string): string {
    return validateHookPath(path, workspaceRoot);
  }

  /** Lists directory candidates for the host-side registration browser. */
  public async browseDirectories(parentPath?: string): Promise<MuximodWorkspaceDirectory[]> {
    const bases = parentPath
      ? [this.policy.assertDirectory(parentPath)]
      : this.policy.roots.filter(isDirectory);
    const candidates = parentPath
      ? safeReadDirectory(bases[0]!).map((entry) => resolve(bases[0]!, entry)).filter(isDirectory)
      : bases;

    return candidates
      .filter((directory) => this.policy.contains(directory))
      .map((directory) => this.toDirectoryCandidate(realpathIfPresent(directory)))
      .sort((left, right) => left.directory.localeCompare(right.directory));
  }

  public toDirectoryOption(record: WorkspaceRecord): MuximodWorkspaceDirectory {
    return {
      id: record.id,
      name: record.name,
      directory: displayPath(record.rootPath),
      isGit: record.isGit,
      setupScriptPath: record.setupScriptPath ? displayPath(record.setupScriptPath) : null,
      cleanupScriptPath: record.cleanupScriptPath ? displayPath(record.cleanupScriptPath) : null,
      worktreeCopyPatterns: record.worktreeCopyPatterns,
    };
  }

  public async resolveWorkspaceDirectory(
    workspaceId: WorkspaceId,
    reader: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>,
  ): Promise<WorkspaceRecord> {
    const workspace = await reader(workspaceId);
    if (!workspace) throw new InvalidWorkspaceDirectoryError(workspaceId, "unknown_workspace", this.policy.roots);
    return this.resolveRegisteredWorkspace(workspace);
  }

  public async resolveLegacyDirectory(directory: string): Promise<string> {
    return this.policy.assertDirectory(directory);
  }

  public async resolveSelection(
    selection: WorkspaceSelection,
    reader: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>,
  ): Promise<WorkspaceRecord> {
    const workspace = await this.resolveWorkspaceDirectory(selection.workspaceId, reader);
    const option: WorkspaceDirectoryOption = {
      id: workspace.id,
      name: workspace.name,
      rootPath: workspace.rootPath,
      isGit: workspace.isGit,
      setupScriptPath: workspace.setupScriptPath,
      cleanupScriptPath: workspace.cleanupScriptPath,
      worktreeCopyPatterns: workspace.worktreeCopyPatterns,
    };
    validateWorkspaceSelection(selection, option);
    return workspace;
  }

  private resolveRegisteredWorkspace(workspace: WorkspaceRecord): WorkspaceRecord {
    const rootPath = this.policy.assertDirectory(workspace.rootPath);
    return Workspace.validate({
      ...workspace,
      rootPath,
      isGit: isGitWorkspace(rootPath),
      ...(workspace.setupScriptPath ? { setupScriptPath: validateHookPath(workspace.setupScriptPath, rootPath) } : {}),
      ...(workspace.cleanupScriptPath ? { cleanupScriptPath: validateHookPath(workspace.cleanupScriptPath, rootPath) } : {}),
      worktreeCopyPatterns: validateWorktreeCopyPatterns(workspace.worktreeCopyPatterns),
    });
  }

  private toDirectoryCandidate(directory: string): MuximodWorkspaceDirectory {
    return {
      id: workspaceIdForPath(directory),
      name: basename(directory) || directory,
      directory: displayPath(directory),
      isGit: isGitWorkspace(directory),
      setupScriptPath: null,
      cleanupScriptPath: null,
      worktreeCopyPatterns: [],
    };
  }
}

export function allowedRootsFromEnvironment(env: NodeJS.ProcessEnv = process.env, fallback = process.cwd()): string[] {
  const configured = (env.MUXIMOD_WORKSPACE_ROOTS ?? env.MUXIMOD_ALLOWED_ROOTS)?.trim();
  return configured ? configured.split(delimiter).map((root) => root.trim()).filter(Boolean) : [fallback];
}

function validateHookPath(path: string, workspaceRoot: string): string {
  const expanded = expandPath(path, workspaceRoot);
  if (!existsSync(expanded)) throw new InvalidWorkspaceHookError(path, "not_found");
  if (!statSync(expanded).isFile()) throw new InvalidWorkspaceHookError(path, "not_file");
  try {
    accessSync(expanded, constants.X_OK);
  } catch {
    throw new InvalidWorkspaceHookError(path, "not_executable");
  }
  return realpathSync(expanded);
}

function validateWorktreeCopyPatterns(values: readonly string[] | undefined): string[] {
  return validateDomainWorktreeCopyPatterns(values ?? []);
}

export function workspaceIdForPath(path: string): WorkspaceId {
  return WorkspaceId.create(createHash("sha256").update(path).digest("hex").slice(0, 16));
}

function expandPath(path: string, basePath = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(basePath, path);
}

function realpathIfPresent(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function safeReadDirectory(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGitWorkspace(path: string): boolean {
  return spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).status === 0;
}

function gitWorkspaceRoot(path: string): string | undefined {
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout ? realpathIfPresent(result.stdout.trim()) : undefined;
}

function displayPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function invalidDirectoryMessage(directory: string, reason: InvalidDirectoryReason): string {
  switch (reason) {
    case "not_found":
      return `Directory does not exist: ${directory}`;
    case "not_directory":
      return `Path is not a directory: ${directory}`;
    case "outside_allowed_root":
      return `Directory is outside the allowed workspace roots: ${directory}`;
    case "unknown_workspace":
      return `Workspace is not registered: ${directory}`;
  }
}

function invalidHookMessage(path: string, reason: InvalidHookReason): string {
  switch (reason) {
    case "not_found":
      return `workspace hook does not exist: ${path}`;
    case "not_file":
      return `workspace hook is not a file: ${path}`;
    case "not_executable":
      return `workspace hook is not executable: ${path}`;
  }
}
