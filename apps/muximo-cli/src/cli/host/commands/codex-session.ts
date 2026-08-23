import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentSessionId, type AgentSessionRecord } from "@muximo/domain";
import {
  codexMeta,
  emptyCodexDiscoveryDiagnostics,
  formatCodexDiscoveryDiagnostics,
  inspectCodexMeta,
  preferredCodexSessionId,
  readCodexBaseline,
  sleep,
  updateSession,
  walkFiles,
} from "../command-support.js";
import type { CodexDiscoveryDiagnostics, CodexSessionCandidate } from "../muximo-command.js";
import {
  type CodexDiscoveryRejection,
  type CodexDiscoveryResult,
  MuximoCommandError,
  _supportedCodexOriginators as supportedCodexOriginators,
} from "../muximo-command.js";

export type LoggerLike = import("./session-lifecycle.js").LoggerLike;

export type CodexSessionDeps = {
  env: NodeJS.ProcessEnv;
  logger: LoggerLike;
  sessions: import("@muximo/application").AgentSessionRepository;
  audit(eventType: string, entityId: string, payload: unknown): void;
  warn(value: string): void;
  info(value: string): void;
  manageRemoteThread(
    session: AgentSessionRecord,
    operation: "name" | "archive" | "unarchive",
    signal?: AbortSignal,
  ): Promise<boolean>;
};

export async function captureCodexSessionBaseline(
  deps: CodexSessionDeps,
  session: AgentSessionRecord,
): Promise<boolean> {
  if (session.backend !== "codex") return true;
  const startedAt = Date.now();
  const logger = deps.logger.child({
    sessionId: session.id,
    sessionName: session.name,
    backend: session.backend,
  });
  logger.debug("codex.baseline_started");
  const files = await codexSessionFiles(deps);
  const baseline = files.map((file) => codexMeta(file)?.session_id).filter((value): value is string => Boolean(value));
  // Baselines are persisted in the same database record as a newline list so
  // a restart never depends on an auxiliary state file.
  session = updateSession(session, { codexSessionBaseline: JSON.stringify({ codexSessions: baseline }) });
  await deps.sessions.update(session);
  logger.debug("codex.baseline_finished", {
    fileCount: files.length,
    sessionCount: baseline.length,
    durationMs: Date.now() - startedAt,
  });
  return true;
}

export async function discoverCodexSessionId(
  deps: CodexSessionDeps,
  startedAt: number,
  runDir: string,
  sessionId: string,
  endedAt?: number,
): Promise<CodexDiscoveryResult> {
  const session = await deps.sessions.findById(AgentSessionId.create(sessionId));
  const logger = deps.logger.child({ sessionId, backend: "codex" });
  const discoveryStartedAt = Date.now();
  logger.debug("codex.session_id_discovery_started", { remote: Boolean(session?.codexRemote) });
  const baseline = new Set<string>(readCodexBaseline(session?.codexSessionBaseline));
  const started = Date.now();
  const root = codexSessionRoot(deps);
  const candidates = codexSessionCandidates(deps, await codexSessionFiles(deps), startedAt, runDir, baseline, endedAt);
  const safeCandidates = await filterCodexSessionCandidates(
    deps,
    candidates.candidates,
    candidates.diagnostics,
    session,
    runDir,
  );
  const result = {
    selectedId: preferredCodexSessionId(safeCandidates),
    candidates: safeCandidates,
    diagnostics: {
      ...candidates.diagnostics,
      rootExists: existsSync(root),
      uniqueCandidates: safeCandidates.length,
      elapsedMs: Date.now() - started,
    },
  };
  logger.debug("codex.session_id_discovery_finished", {
    found: Boolean(result.selectedId),
    candidateCount: result.candidates.length,
    candidateFileCount: result.diagnostics.candidateFiles,
    durationMs: Date.now() - discoveryStartedAt,
  });
  return result;
}

export async function filterCodexSessionCandidates(
  deps: CodexSessionDeps,
  candidates: CodexSessionCandidate[],
  diagnostics: Omit<CodexDiscoveryDiagnostics, "rootExists" | "elapsedMs">,
  session: AgentSessionRecord | undefined,
  runDir: string,
): Promise<CodexSessionCandidate[]> {
  if (!session) return candidates;
  const sessions = await deps.sessions.list(session.workspaceId);
  const otherSessions = sessions.filter((candidate) => candidate.id !== session.id);
  const unboundSameDirectory = otherSessions.some(
    (candidate) =>
      candidate.backend === "codex" &&
      !candidate.backendSessionId &&
      (candidate.worktreePath ?? candidate.workspaceRoot) === runDir,
  );
  const reject = (reason: CodexDiscoveryRejection): void => {
    diagnostics.rejected[reason] = (diagnostics.rejected[reason] ?? 0) + 1;
  };
  return candidates.filter((candidate) => {
    if (otherSessions.some((other) => other.backendSessionId === candidate.id)) {
      reject("known_to_other_session");
      return false;
    }
    if (unboundSameDirectory) {
      reject("competing_session");
      return false;
    }
    return true;
  });
}

export async function recoverCodexSessionId(
  deps: CodexSessionDeps,
  session: AgentSessionRecord,
  runDir: string,
): Promise<CodexDiscoveryResult> {
  const createdAt = Date.parse(session.createdAt);
  if (!Number.isFinite(createdAt)) {
    return {
      candidates: [],
      diagnostics: emptyCodexDiscoveryDiagnostics(existsSync(codexSessionRoot(deps))),
    };
  }
  const updatedAt = session.lastExitStatus === undefined ? Number.NaN : Date.parse(session.updatedAt);
  const result = await discoverCodexSessionId(
    deps,
    Math.floor(createdAt / 1_000),
    runDir,
    session.id,
    Number.isFinite(updatedAt) ? updatedAt / 1_000 : undefined,
  );
  if (result.candidates.length === 1) return { ...result, selectedId: result.candidates[0]?.id };
  const ownershipRejected =
    (result.diagnostics.rejected.known_to_other_session ?? 0) + (result.diagnostics.rejected.competing_session ?? 0);
  if (result.candidates.length > 1 || ownershipRejected > 0) {
    deps.warn(
      `cannot safely recover Codex session ID for '${session.name}'; found ${result.diagnostics.candidateFiles} matching rollouts (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`,
    );
  } else {
    deps.warn(
      `cannot recover Codex session ID for '${session.name}' (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`,
    );
  }
  return { ...result, selectedId: undefined };
}

export async function repairCodexSessionId(
  deps: CodexSessionDeps,
  session: AgentSessionRecord,
  runDir: string,
  phase: "run" | "resume",
): Promise<AgentSessionRecord> {
  if (session.backend !== "codex" || session.backendSessionId) return session;
  const result = await recoverCodexSessionId(deps, session, runDir);
  if (!result.selectedId) {
    deps.audit("agent_session.codex_session_id_recovery_failed", session.id, {
      name: session.name,
      phase,
      runDir,
      diagnostics: result.diagnostics,
    });
    return session;
  }
  await deps.sessions.setBackendSessionIdIfMissing(session.id, result.selectedId);
  const persisted = await deps.sessions.findById(session.id);
  if (!persisted?.backendSessionId)
    throw new MuximoCommandError(`session '${session.name}' disappeared while repairing its backend session ID`);
  deps.info(`recovered Codex session ID for '${session.name}' during ${phase}`);
  return persisted;
}

export function reportCodexDiscoveryFailure(
  deps: CodexSessionDeps,
  session: AgentSessionRecord,
  runDir: string,
  phase: "cleanup" | "finalize" | "resume" | "run",
  result: CodexDiscoveryResult,
): void {
  const diagnostics = formatCodexDiscoveryDiagnostics(result.diagnostics);
  deps.warn(
    `Codex session ID could not be found; '${session.name}' cannot be resumed until the mapping is repaired (${diagnostics})`,
  );
  deps.audit("agent_session.codex_session_id_missing", session.id, {
    name: session.name,
    phase,
    runDir,
    diagnostics: result.diagnostics,
  });
}

function codexSessionCandidates(
  _deps: CodexSessionDeps,
  files: string[],
  startedAt: number,
  runDir: string,
  baseline: Set<string>,
  endedAt?: number,
): { candidates: CodexSessionCandidate[]; diagnostics: Omit<CodexDiscoveryDiagnostics, "rootExists" | "elapsedMs"> } {
  const candidates = new Map<string, CodexSessionCandidate>();
  const diagnostics: Omit<CodexDiscoveryDiagnostics, "rootExists" | "elapsedMs"> = {
    filesScanned: files.length,
    sessionMetaFiles: 0,
    payloadMetadataFiles: 0,
    flatMetadataFiles: 0,
    baselineEntries: baseline.size,
    candidateFiles: 0,
    uniqueCandidates: 0,
    rejected: {},
  };
  const reject = (reason: CodexDiscoveryRejection): void => {
    diagnostics.rejected[reason] = (diagnostics.rejected[reason] ?? 0) + 1;
  };
  for (const file of files) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(file);
    } catch {
      reject("stat_error");
      continue;
    }
    const inspection = inspectCodexMeta(file);
    if (!inspection.meta) {
      reject(inspection.rejection ?? "read_error");
      continue;
    }
    diagnostics.sessionMetaFiles += 1;
    if (inspection.shape === "payload") diagnostics.payloadMetadataFiles += 1;
    else diagnostics.flatMetadataFiles += 1;
    const meta = inspection.meta;
    if (!meta.session_id) {
      reject("missing_session_id");
      continue;
    }
    if (stat.mtimeMs / 1000 < startedAt) {
      reject("before_started_at");
      continue;
    }
    if (endedAt !== undefined && stat.mtimeMs / 1000 > endedAt) {
      reject("after_session_updated_at");
      continue;
    }
    if (meta.cwd !== runDir) {
      reject("cwd_mismatch");
      continue;
    }
    if (!supportedCodexOriginators.has(meta.originator ?? "")) {
      reject("unsupported_originator");
      continue;
    }
    if (meta.thread_source === "subagent") {
      reject("subagent");
      continue;
    }
    if (baseline.has(meta.session_id)) {
      reject("baseline");
      continue;
    }
    const candidate = {
      id: meta.session_id,
      mtime: stat.mtimeMs,
      rolloutIdMatches: meta.session_id === meta.id,
    };
    diagnostics.candidateFiles += 1;
    const previous = candidates.get(candidate.id);
    const isPreferred = candidate.rolloutIdMatches && !previous?.rolloutIdMatches;
    const isNewerSameKind =
      previous && candidate.rolloutIdMatches === previous.rolloutIdMatches && candidate.mtime > previous.mtime;
    if (!previous || isPreferred || isNewerSameKind) {
      candidates.set(candidate.id, candidate);
    }
  }
  const sorted = [...candidates.values()].sort((left, right) => {
    if (left.rolloutIdMatches !== right.rolloutIdMatches) return left.rolloutIdMatches ? -1 : 1;
    return right.mtime - left.mtime;
  });
  diagnostics.uniqueCandidates = sorted.length;
  return { candidates: sorted, diagnostics };
}

export function codexSessionRoot(deps: CodexSessionDeps): string {
  return join(deps.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

async function codexSessionFiles(deps: CodexSessionDeps): Promise<string[]> {
  const root = codexSessionRoot(deps);
  return existsSync(root) ? walkFiles(root).filter((file) => file.endsWith(".jsonl")) : [];
}

export function watchCodexSessionName(
  deps: CodexSessionDeps,
  session: AgentSessionRecord,
  startedAt: number,
  runDir: string,
): { stop: () => Promise<void> } {
  let stopped = false;
  const controller = new AbortController();
  const run = async () => {
    while (!stopped) {
      const discovery = await discoverCodexSessionId(deps, startedAt, runDir, session.id);
      if (discovery.selectedId) {
        try {
          await deps.sessions.setBackendSessionIdIfMissing(session.id, discovery.selectedId);
          await deps.manageRemoteThread(
            { ...session, backendSessionId: discovery.selectedId },
            "name",
            controller.signal,
          );
          return;
        } catch {
          // The app-server may expose the rollout shortly after the JSONL file.
        }
      }
      await sleep(200);
    }
  };
  const promise = run().catch(() => undefined);
  return {
    stop: async () => {
      stopped = true;
      controller.abort();
      await Promise.race([promise, sleep(250)]);
    },
  };
}
