import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize, resolve } from "node:path";
import type { ApplicationEffect, SessionWorktreeLookup, ShellWorkspaceResolver } from "@muximo/application";
import type { WorkspaceDirectory } from "@muximo/contract/api";
import { type WorkspaceDirectoryOption, WorkspaceId } from "@muximo/domain";
import {
  fromPromise,
  gitWorkspaceRoot,
  isPathWithin,
  realpathSafe,
  workspaceIdForPath,
} from "@muximo/infrastructure/cli-client";
import type { MuximodApiClient } from "./muximod-api-client.js";

type MuximodApiProvider = () => Promise<MuximodApiClient>;

/** Resolves shell workspace context from the daemon API and local Git state. */
export class MuximodShellWorkspaceResolver implements ShellWorkspaceResolver {
  private readonly cwd: string;

  public constructor(
    private readonly options: {
      cwd: string;
      environment: NodeJS.ProcessEnv;
      api: MuximodApiProvider;
    },
  ) {
    this.cwd = realpathSafe(options.cwd);
  }

  public resolveCurrent(): ApplicationEffect<WorkspaceDirectoryOption> {
    return fromPromise(() => this.resolveCurrentPromise());
  }

  private async resolveCurrentPromise(): Promise<WorkspaceDirectoryOption> {
    const workspaces = (await this.options.api()).workspaces;
    const records = (await workspaces.list()).map((value) => toWorkspaceDirectoryOption(value, this.cwd));
    const selectedWorkspaceId = this.options.environment.MUXIMOD_WORKSPACE_ID?.trim();
    if (selectedWorkspaceId) {
      const selected = records.find((workspace) => workspace.id === selectedWorkspaceId);
      if (selected) return selected;
    }

    const gitRoot = gitWorkspaceRoot(this.cwd);
    const root = gitRoot ?? this.cwd;
    const id = workspaceIdForPath(root);
    const existing =
      records.find((workspace) => workspace.id === id) ?? findRegisteredWorkspaceForCwd(records, this.cwd, root);
    return existing ?? createDerivedWorkspace(root, gitRoot !== undefined, id);
  }
}

/** Resolves a managed shell worktree using session data returned by the daemon. */
export class MuximodShellSessionWorktreeLookup implements SessionWorktreeLookup {
  public constructor(private readonly api: MuximodApiProvider) {}

  public findWorktreePath(
    workspaceId: WorkspaceDirectoryOption["id"],
    sessionName: string,
    fallbackCwd: string,
  ): ApplicationEffect<string> {
    return fromPromise(() => this.findWorktreePathPromise(workspaceId, sessionName, fallbackCwd));
  }

  private async findWorktreePathPromise(
    workspaceId: WorkspaceDirectoryOption["id"],
    sessionName: string,
    fallbackCwd: string,
  ): Promise<string> {
    const result = await (await this.api()).agentSessions.list({
      workspaceScope: "all",
      includeUnavailable: true,
    });
    const session = result.allViews.find(
      (view) => view.session.workspaceId === workspaceId && view.session.name === sessionName,
    )?.session;
    if (session?.useWorktree && session.worktreePath && existsSync(session.worktreePath)) {
      return session.worktreePath;
    }
    return realpathSafe(fallbackCwd);
  }
}

function toWorkspaceDirectoryOption(value: WorkspaceDirectory, cwd: string): WorkspaceDirectoryOption {
  return {
    id: WorkspaceId.create(value.id),
    rootPath: resolveDisplayPath(value.directory, cwd),
    name: value.name,
    isGit: value.isGit,
    ...(value.setupScriptPath === null ? {} : { setupScriptPath: resolveDisplayPath(value.setupScriptPath, cwd) }),
    ...(value.cleanupScriptPath === null
      ? {}
      : { cleanupScriptPath: resolveDisplayPath(value.cleanupScriptPath, cwd) }),
  };
}

function findRegisteredWorkspaceForCwd(
  records: readonly WorkspaceDirectoryOption[],
  cwd: string,
  gitRoot: string,
): WorkspaceDirectoryOption | undefined {
  if (cwd === gitRoot) return undefined;
  return records
    .filter((workspace) => workspace.rootPath !== gitRoot)
    .filter((workspace) => isPathWithin(gitRoot, workspace.rootPath) && isPathWithin(workspace.rootPath, cwd))
    .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

function createDerivedWorkspace(
  rootPath: string,
  isGit: boolean,
  id: WorkspaceDirectoryOption["id"],
): WorkspaceDirectoryOption {
  return {
    id,
    rootPath,
    name: basename(rootPath),
    isGit,
  };
}

function resolveDisplayPath(value: string, cwd: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
  return realpathSafe(normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded)));
}
