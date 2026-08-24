import { existsSync } from "node:fs";
import type {
  ManagedAgentSessionRepository,
  ProcessResult,
  SessionWorktreeLookupPort,
  ShellProcessInput,
  ShellProcessPort,
} from "@muximo/application";
import { resolveExecutable } from "../agents/launch.js";
import { spawnAttached } from "../process/process.js";
import { realpathSafe } from "./filesystem.js";

export type ShellProcessAdapterOptions = {
  environment: NodeJS.ProcessEnv;
};

/** Resolves and runs one attached shell process; it owns no shell workflow. */
export class ShellProcessAdapter implements ShellProcessPort {
  public constructor(private readonly options: ShellProcessAdapterOptions) {}

  public async run(input: ShellProcessInput): Promise<ProcessResult> {
    const executable = resolveExecutable(input.executable, this.options.environment);
    const environment: NodeJS.ProcessEnv = {
      ...this.options.environment,
      MUXIMOD_WRAPPED_SHELL: "1",
    };
    if (input.interactive) delete environment.MUXIMOD_WORKTREE_SESSION_NAME;
    return spawnAttached(executable, [...input.args], input.cwd, environment);
  }
}

export type SessionWorktreeLookupAdapterOptions = {
  sessions: ManagedAgentSessionRepository;
};

/** Observes a wrapped shell's managed worktree without owning shell policy. */
export class SessionWorktreeLookupAdapter implements SessionWorktreeLookupPort {
  public constructor(private readonly options: SessionWorktreeLookupAdapterOptions) {}

  public async findWorktreePath(
    workspaceId: Parameters<ManagedAgentSessionRepository["findByName"]>[0],
    sessionName: string,
    fallbackCwd: string,
  ): Promise<string> {
    try {
      const session = await this.options.sessions.findByName(workspaceId, sessionName);
      if (session?.useWorktree && session.worktreePath && existsSync(session.worktreePath)) {
        return session.worktreePath;
      }
    } catch {
      // A shell remains usable when optional session metadata is unavailable.
    }
    return realpathSafe(fallbackCwd);
  }
}
