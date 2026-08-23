import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentSessionRecord, WorkspaceRecord } from "@muximo/domain";
import { isProcessAlive, realpathSafe } from "../command-support.js";
import { type GitWorktreeRegistry, MuximoCommandError } from "../muximo-command.js";
import { padHeader, padRow, sessionHealthLabel, sessionResumeLabel, toSessionJson } from "../presenters.js";
import {
  projectAgentSession,
  type SessionListProjection,
  type SessionWorktreeState,
  shouldCheckSessionWorktree,
} from "../session-list.js";

type SessionListOptions = {
  global: boolean;
  names: boolean;
  json: boolean;
  all: boolean;
};

export type ListSessionsDeps = {
  env: NodeJS.ProcessEnv;
  logger: { child(fields: Record<string, unknown>): { debug(event: string, fields?: Record<string, unknown>): void } };
  write(text: string): void;
  info(message: string): void;
  resolveWorkspace(): Promise<Pick<WorkspaceRecord, "id">>;
  sessions: { list(workspaceId?: unknown): Promise<AgentSessionRecord[]> };
};

export function parseListOptions(deps: Pick<ListSessionsDeps, "write">, args: string[]): SessionListOptions {
  let global = false;
  let names = false;
  let json = false;
  let all = false;
  for (const argument of args) {
    if (argument === "-g" || argument === "--global") global = true;
    else if (argument === "--all") all = true;
    else if (argument === "--names") names = true;
    else if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") {
      deps.write("Usage: muximo list [--global] [--all] [--names|--json]\n");
      return { global, names: false, json: false, all: false };
    } else throw new MuximoCommandError(`unknown list option: ${argument}`);
  }
  if (names && json) throw new MuximoCommandError("--names and --json cannot be combined");
  return { global, names, json, all };
}

export async function listSessions(options: SessionListOptions, deps: ListSessionsDeps): Promise<number> {
  const logger = deps.logger.child({ command: "list" });
  const startedAt = Date.now();
  logger.debug("session.list_started", {
    global: options.global,
    names: options.names,
    json: options.json,
    all: options.all,
  });
  const workspace = options.global ? undefined : (await deps.resolveWorkspace()).id;
  const allViews = projectSessionList(await deps.sessions.list(workspace), deps.env);
  const views = options.all ? allViews : allViews.filter((view) => view.visibleByDefault);
  const finish = (status: number): number => {
    logger.debug("session.list_finished", {
      status,
      count: views.length,
      hiddenCount: allViews.length - views.length,
      durationMs: Date.now() - startedAt,
    });
    return status;
  };
  if (options.names) {
    for (const view of views) {
      const session = view.session;
      deps.write(`${options.global ? `${session.workspaceName}/` : ""}${session.name}\n`);
    }
    return finish(0);
  }
  if (options.json) {
    for (const view of views) deps.write(`${JSON.stringify(toSessionJson(view))}\n`);
    return finish(0);
  }
  if (options.global)
    deps.write(padHeader(["WORKSPACE", "NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
  else deps.write(padHeader(["NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
  if (views.length === 0) {
    deps.info(
      allViews.length === 0
        ? "no managed sessions"
        : "no visible managed sessions; use --all to include unavailable sessions",
    );
    return finish(0);
  }
  for (const view of views) {
    const session = view.session;
    const values = [
      session.name,
      session.backend,
      session.status,
      sessionHealthLabel(view.executionHealth),
      sessionResumeLabel(view.resume),
      session.branch ?? "-",
      session.worktreePath ?? "-",
    ];
    deps.write(options.global ? padRow([session.workspaceName, ...values]) : padRow(values));
  }
  return finish(0);
}

export function projectSessionList(sessions: AgentSessionRecord[], env: NodeJS.ProcessEnv): SessionListProjection[] {
  const now = Date.now();
  const registries = new Map<string, GitWorktreeRegistry>();
  return sessions.map((session) => {
    const processAlive =
      (session.status === "running" || session.status === "resuming") && session.executionPid !== undefined
        ? isProcessAlive(session.executionPid)
        : undefined;
    return projectAgentSession(session, {
      now,
      processAlive,
      worktreeState: inspectSessionWorktree(session, now, registries, env),
    });
  });
}

function inspectSessionWorktree(
  session: AgentSessionRecord,
  now: number,
  registries: Map<string, GitWorktreeRegistry>,
  env: NodeJS.ProcessEnv,
): SessionWorktreeState {
  if (!session.useWorktree) return "not_applicable";
  if (!shouldCheckSessionWorktree(session, now)) return "unknown";
  if (!session.worktreePath || !existsSync(session.worktreePath)) return "missing";

  const workspaceRoot = realpathSafe(session.workspaceRoot);
  let registry = registries.get(workspaceRoot);
  if (!registry) {
    registry = readGitWorktreeRegistry(workspaceRoot, env);
    registries.set(workspaceRoot, registry);
  }
  if (!registry.ok) return "unknown";
  return registry.paths.has(realpathSafe(session.worktreePath)) ? "available" : "unregistered";
}

function readGitWorktreeRegistry(workspaceRoot: string, env: NodeJS.ProcessEnv): GitWorktreeRegistry {
  try {
    const output = execFileSync("git", ["-C", workspaceRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths = new Set(
      output
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => realpathSafe(line.slice("worktree ".length).trim())),
    );
    return { ok: true, paths };
  } catch {
    return { ok: false };
  }
}
