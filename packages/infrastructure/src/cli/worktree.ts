import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CleanupResult,
  ManagedWorktreeState,
  ShellWorktree,
  ShellWorktreePort,
  WorktreePort,
} from "@muximo/application";
import {
  type AgentSessionRecord,
  isValidWorktreeCopyPattern,
  normalizeWorktreeCopyPatterns,
  type WorkspaceRecord,
} from "@muximo/domain";
import { errorFields, type Logger } from "../logging/index.js";
import { isPathWithin, realpathAfterMkdir, realpathSafe, resolveFromRoot, unlinkEmptyDirectory } from "./filesystem.js";
import { gitOutputOrEmpty, gitOutputRaw, gitRequired, gitStatus, gitStatusCode, listUnmanagedFiles } from "./git.js";

export type WorktreeAdapterOptions = {
  environment: NodeJS.ProcessEnv;
  logger: Logger;
};

/** Git worktree capability adapter; it has no session orchestration policy. */
export class GitWorktreeAdapter implements WorktreePort {
  public constructor(private readonly options: WorktreeAdapterOptions) {}

  public async create(workspace: WorkspaceRecord, name: string, override?: string): Promise<ManagedWorktreeState> {
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

  public async copyFiles(
    target: Pick<AgentSessionRecord, "workspaceRoot" | "worktreePath">,
    configuredPatterns: readonly string[],
  ): Promise<boolean> {
    if (!target.worktreePath || configuredPatterns.length === 0) return true;
    const patterns = normalizeWorktreeCopyPatterns(configuredPatterns);
    if (patterns.some((pattern) => !isValidWorktreeCopyPattern(pattern))) {
      this.options.logger.warn("worktree.copy_pattern_invalid", { patternCount: patterns.length });
      return false;
    }
    const sourceFiles = listUnmanagedFiles(target.workspaceRoot, this.options.environment);
    const matchedFiles = new Set<string>();
    for (const pattern of patterns) {
      const matches = sourceFiles.filter((file) => matchesWorktreeCopyPattern(pattern, file));
      if (matches.length === 0) this.options.logger.warn("worktree.copy_pattern_unmatched", { pattern });
      for (const file of matches) matchedFiles.add(file);
    }
    for (const relativePath of [...matchedFiles].sort()) {
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

  public create(workspace: WorkspaceRecord, name: string): Promise<ManagedWorktreeState> {
    return this.worktrees.create(workspace, name);
  }

  public copyFiles(
    target: Pick<ShellWorktree, "workspaceRoot" | "worktreePath">,
    patterns: readonly string[],
  ): Promise<boolean> {
    return this.worktrees.copyFiles(target, patterns);
  }

  public async remove(input: ShellWorktree): Promise<void> {
    this.worktrees.removeShell(input);
  }
}

function matchesWorktreeCopyPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  const memo = new Map<string, boolean>();
  const match = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === patternSegments.length) result = pathIndex === pathSegments.length;
    else if (patternSegments[patternIndex] === "**") {
      result =
        match(patternIndex + 1, pathIndex) || (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    } else {
      const patternSegment = patternSegments[patternIndex];
      const pathSegment = pathSegments[pathIndex];
      result =
        patternSegment !== undefined &&
        pathSegment !== undefined &&
        matchSegmentPattern(patternSegment, pathSegment) &&
        match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function matchSegmentPattern(pattern: string, value: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else expression += /[.\\+^$()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`).test(value);
}
