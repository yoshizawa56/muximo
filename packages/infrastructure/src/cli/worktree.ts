import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CleanupResult,
  ManagedWorktreeState,
  ShellWorktree,
  ShellWorktreePort,
  WorktreePort,
} from "@muximo/application";
import type { AgentSessionRecord, WorkspaceDirectoryOption } from "@muximo/domain";
import { errorFields, type Logger } from "../logging/index.js";
import { isPathWithin, realpathAfterMkdir, realpathSafe, resolveFromRoot, unlinkEmptyDirectory } from "./filesystem.js";
import {
  gitOutputOrEmpty,
  gitOutputRaw,
  gitRequired,
  gitStatus,
  gitStatusCode,
  listIgnoredDirectories,
  listIgnoredFiles,
} from "./git.js";
import { readWorktreeInclude } from "./worktreeinclude.js";

export type WorktreeAdapterOptions = {
  environment: NodeJS.ProcessEnv;
  logger: Logger;
};

/** Git worktree capability adapter; it has no session orchestration policy. */
export class GitWorktreeAdapter implements WorktreePort {
  public constructor(private readonly options: WorktreeAdapterOptions) {}

  public async create(
    workspace: WorkspaceDirectoryOption,
    name: string,
    override?: string,
  ): Promise<ManagedWorktreeState> {
    if (!workspace.isGit) throw new Error("a managed worktree requires a git workspace; use --no-worktree here");
    const defaultRoot =
      this.options.environment.MUXIMO_WORKTREE_ROOT ?? join(dirname(workspace.rootPath), `${workspace.name}.worktrees`);
    const configuredRoot =
      override ??
      (this.options.environment.MUXIMO_WORKTREE_ROOT
        ? defaultRoot
        : this.options.environment.MUXIMO_WORKTREE_ID
          ? join(defaultRoot, this.options.environment.MUXIMO_WORKTREE_ID)
          : defaultRoot);
    const worktreeRoot = realpathAfterMkdir(resolveFromRoot(configuredRoot, workspace.rootPath));
    const worktreePath = join(worktreeRoot, name);
    let branch = this.branch(name);
    const baseCommit = gitRequired(
      workspace.rootPath,
      ["rev-parse", "HEAD"],
      "cannot determine the workspace HEAD",
      this.options.environment,
    );
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) {
      branch = `muximo/${this.options.environment.MUXIMO_WORKTREE_ID ?? workspace.id}/${name}`;
    }
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) {
      throw new Error(`muximo branch already exists; choose another name or remove it manually: ${branch}`);
    }
    const worktreePathWasAbsent = !existsSync(worktreePath);
    if (!worktreePathWasAbsent) throw new Error(`worktree path already exists: ${worktreePath}`);
    this.options.logger.info("worktree.create_started", { worktreePath, branch, baseCommit });
    try {
      gitRequired(
        workspace.rootPath,
        ["worktree", "add", "-b", branch, "--", worktreePath, baseCommit],
        "git worktree creation failed",
        this.options.environment,
      );
    } catch (error) {
      this.cleanupFailedCreation(
        workspace.rootPath,
        worktreeRoot,
        worktreePath,
        worktreePathWasAbsent,
        branch,
        baseCommit,
      );
      throw error;
    }
    return { worktreeRoot, worktreePath, branch, baseCommit };
  }

  public async copyFiles(target: Pick<AgentSessionRecord, "workspaceRoot" | "worktreePath">): Promise<boolean> {
    if (!target.worktreePath) return true;

    let include: ReturnType<typeof readWorktreeInclude>;
    try {
      include = readWorktreeInclude(target.workspaceRoot);
    } catch (error) {
      this.options.logger.warn("worktree.include_invalid", { ...errorFields(error) });
      return false;
    }
    if (!include) return true;

    let sourceFiles: string[];
    let ignoredDirectories: string[];
    try {
      sourceFiles = listIgnoredFiles(target.workspaceRoot, this.options.environment);
      ignoredDirectories = listIgnoredDirectories(target.workspaceRoot, this.options.environment);
    } catch (error) {
      this.options.logger.warn("worktree.include_source_discovery_failed", { ...errorFields(error) });
      return false;
    }
    const matchedFiles = sourceFiles.filter(
      (relativePath) => isSafeRelativePath(relativePath) && include.matches(relativePath, ignoredDirectories),
    );
    for (const relativePath of matchedFiles.sort()) {
      const sourcePath = resolve(target.workspaceRoot, relativePath);
      const targetPath = resolve(target.worktreePath, relativePath);
      if (!isPathWithin(target.workspaceRoot, sourcePath) || !isPathWithin(target.worktreePath, targetPath)) {
        this.options.logger.warn("worktree.copy_refused", { reason: "outside_target", relativePath });
        return false;
      }
      try {
        const sourceStat = lstatSync(sourcePath);
        if (!sourceStat.isFile()) {
          this.options.logger.warn("worktree.copy_refused", { reason: "non_regular_file", relativePath });
          return false;
        }
        if (!isPathWithin(target.workspaceRoot, realpathSafe(sourcePath))) {
          this.options.logger.warn("worktree.copy_refused", { reason: "outside_source", relativePath });
          return false;
        }
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        if (!isPathWithin(target.worktreePath, realpathSafe(dirname(targetPath)))) {
          this.options.logger.warn("worktree.copy_refused", { reason: "symlink", relativePath });
          return false;
        }
        copyFileSync(sourcePath, targetPath);
        chmodSync(targetPath, sourceStat.mode & 0o777);
      } catch (error) {
        this.options.logger.warn("worktree.copy_failed", { relativePath, ...errorFields(error) });
        return false;
      }
    }
    return true;
  }

  public async isRegistered(session: AgentSessionRecord): Promise<boolean> {
    if (!session.worktreePath) return false;
    return this.isRegisteredAt(session.workspaceRoot, session.worktreePath);
  }

  public async hasChanges(session: AgentSessionRecord): Promise<boolean> {
    if (!session.worktreePath || !existsSync(session.worktreePath)) return false;
    return gitStatus(session.worktreePath, this.options.environment) !== (session.baselineStatus ?? "");
  }

  public async remove(session: AgentSessionRecord, force: boolean): Promise<CleanupResult> {
    if (!session.useWorktree || !session.worktreePath) return { disposition: "removed" };
    if (existsSync(session.worktreePath) && !(await this.isRegistered(session))) {
      this.options.logger.warn("worktree.remove_refused_unregistered", { worktreePath: session.worktreePath });
      return { disposition: "failed", reason: "unregistered_worktree" };
    }
    if (existsSync(session.worktreePath)) {
      try {
        gitRequired(
          session.workspaceRoot,
          ["worktree", "remove", ...(force ? ["--force"] : []), "--", session.worktreePath],
          "git worktree removal failed",
          this.options.environment,
        );
      } catch (error) {
        this.options.logger.warn("worktree.remove_failed", {
          worktreePath: session.worktreePath,
          ...errorFields(error),
        });
        return { disposition: "failed", reason: "worktree_removal_failed" };
      }
      unlinkEmptyDirectory(session.worktreeRoot);
      if (session.branch) {
        const head = gitOutputOrEmpty(
          session.workspaceRoot,
          ["rev-parse", "--verify", session.branch],
          this.options.environment,
        );
        if (head && head === session.baseCommit) gitStatusCode(session.workspaceRoot, ["branch", "-d", session.branch]);
        else if (head)
          this.options.logger.info("worktree.branch_retained", { branch: session.branch, kind: "managed" });
      }
    }
    return { disposition: "removed" };
  }

  public isRegisteredAt(workspaceRoot: string, worktreePath: string): boolean {
    return this.isRegisteredAtInternal(workspaceRoot, worktreePath);
  }

  public hasChangesAt(worktreePath: string, baseline = ""): boolean {
    return gitStatus(worktreePath, this.options.environment) !== baseline;
  }

  public removeShell(input: {
    workspaceRoot: string;
    worktreeRoot: string | null;
    worktreePath: string;
    branch: string | null;
    baseCommit: string | null;
  }): void {
    if (!this.isRegisteredAtInternal(input.workspaceRoot, input.worktreePath)) {
      this.options.logger.warn("worktree.shell_remove_refused_unregistered", { worktreePath: input.worktreePath });
      return;
    }
    if (this.hasChangesAt(input.worktreePath)) {
      this.options.logger.warn("worktree.shell_remove_refused_dirty", {
        worktreePath: input.worktreePath,
        branch: input.branch,
      });
      return;
    }
    try {
      gitRequired(
        input.workspaceRoot,
        ["worktree", "remove", "--", input.worktreePath],
        "git worktree removal failed",
        this.options.environment,
      );
    } catch (error) {
      this.options.logger.warn("worktree.shell_remove_failed", {
        worktreePath: input.worktreePath,
        ...errorFields(error),
      });
      return;
    }
    unlinkEmptyDirectory(input.worktreeRoot);
    if (input.branch) {
      const head = gitOutputOrEmpty(
        input.workspaceRoot,
        ["rev-parse", "--verify", input.branch],
        this.options.environment,
      );
      if (head && head === input.baseCommit) gitStatusCode(input.workspaceRoot, ["branch", "-d", input.branch]);
      else if (head) this.options.logger.info("worktree.branch_retained", { branch: input.branch, kind: "shell" });
    }
  }

  private branch(name: string): string {
    const worktreeId = this.options.environment.MUXIMO_WORKTREE_ID;
    return worktreeId ? `muximo/${worktreeId}/${name}` : `muximo/${name}`;
  }

  private isRegisteredAtInternal(workspaceRoot: string, worktreePath: string): boolean {
    return gitOutputRaw(workspaceRoot, ["worktree", "list", "--porcelain"], this.options.environment)
      .split("\n")
      .some((line) => line === `worktree ${worktreePath}`);
  }

  private cleanupFailedCreation(
    workspaceRoot: string,
    worktreeRoot: string,
    worktreePath: string,
    worktreePathWasAbsent: boolean,
    branch: string,
    baseCommit: string,
  ): void {
    try {
      let canRemoveBranch = !existsSync(worktreePath);
      if (existsSync(worktreePath) && this.isRegisteredAtInternal(workspaceRoot, worktreePath)) {
        gitRequired(
          workspaceRoot,
          ["worktree", "remove", "--force", "--", worktreePath],
          "git worktree removal failed",
          this.options.environment,
        );
        canRemoveBranch = !existsSync(worktreePath);
      } else if (worktreePathWasAbsent) {
        canRemoveBranch = this.removeUnregisteredPartialWorktree(workspaceRoot, worktreeRoot, worktreePath);
      }
      if (canRemoveBranch) {
        const head = gitOutputOrEmpty(workspaceRoot, ["rev-parse", "--verify", branch], this.options.environment);
        if (head && head === baseCommit)
          gitStatusCode(workspaceRoot, ["branch", "-d", branch], this.options.environment);
      }
    } catch (cleanupError) {
      this.options.logger.warn("worktree.create_cleanup_failed", {
        worktreePath,
        ...errorFields(cleanupError),
      });
    }
  }

  private removeUnregisteredPartialWorktree(
    workspaceRoot: string,
    worktreeRoot: string,
    worktreePath: string,
  ): boolean {
    if (!existsSync(worktreePath)) return true;

    const resolvedRoot = realpathSafe(worktreeRoot);
    const resolvedPath = realpathSafe(worktreePath);
    if (!isPathWithin(resolvedRoot, resolvedPath) || resolvedRoot === resolvedPath) return false;

    let worktreeStat: ReturnType<typeof lstatSync>;
    let gitFileStat: ReturnType<typeof lstatSync>;
    try {
      worktreeStat = lstatSync(worktreePath);
      gitFileStat = lstatSync(join(worktreePath, ".git"));
    } catch {
      return false;
    }
    if (!worktreeStat.isDirectory() || !gitFileStat.isFile()) return false;

    let gitdir: string | undefined;
    try {
      gitdir = readFileSync(join(worktreePath, ".git"), "utf8")
        .split(/\r?\n/u)
        .map((line) => line.match(/^gitdir:\s*(.+)$/u)?.[1]?.trim())
        .find((value): value is string => Boolean(value));
    } catch {
      return false;
    }
    if (!gitdir) return false;

    const commonDirectory = gitOutputOrEmpty(
      workspaceRoot,
      ["rev-parse", "--git-common-dir"],
      this.options.environment,
    );
    const worktreeAdministrativeRoot = realpathSafe(resolve(workspaceRoot, commonDirectory || ".git", "worktrees"));
    const resolvedGitdir = realpathSafe(resolve(worktreePath, gitdir));
    if (!isPathWithin(worktreeAdministrativeRoot, resolvedGitdir)) return false;

    rmSync(worktreePath, { recursive: true, force: true });
    unlinkEmptyDirectory(worktreeRoot);
    return !existsSync(worktreePath);
  }
}

/** Adapts the Git capability to the shell workflow without moving policy into infrastructure. */
export class GitShellWorktreeAdapter implements ShellWorktreePort {
  public constructor(private readonly worktrees: GitWorktreeAdapter) {}

  public create(workspace: WorkspaceDirectoryOption, name: string): Promise<ManagedWorktreeState> {
    return this.worktrees.create(workspace, name);
  }

  public copyFiles(target: Pick<ShellWorktree, "workspaceRoot" | "worktreePath">): Promise<boolean> {
    return this.worktrees.copyFiles(target);
  }

  public async remove(input: ShellWorktree): Promise<void> {
    this.worktrees.removeShell(input);
  }
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\u0000") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}
