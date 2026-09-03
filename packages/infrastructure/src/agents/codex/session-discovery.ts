import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentSessionRepository, ApplicationError } from "@muximo/application";
import { type AgentSession, AgentSessionId } from "@muximo/domain";
import { runEffectAsPromise } from "../../effect.js";
import type { Logger } from "../../logging/index.js";
import {
  type CodexDiscoveryDiagnostics,
  type CodexDiscoveryRejection,
  type CodexDiscoveryResult,
  type CodexSessionCandidate,
  codexMeta,
  formatCodexDiscoveryDiagnostics,
  inspectCodexMeta,
  preferredCodexSessionId,
  readCodexBaseline,
  sleep,
  supportedCodexOriginators,
  walkFiles,
} from "./internals.js";
import type { CodexSessionStateRepository } from "./state.js";

type LoggerLike = Pick<Logger, "debug"> & {
  child(context: Record<string, unknown>): Pick<Logger, "debug" | "info" | "warn">;
};
export type CodexSessionDeps = {
  env: NodeJS.ProcessEnv;
  logger: Pick<Logger, "debug" | "info" | "warn"> & LoggerLike;
  sessions: AgentSessionRepository;
  state: CodexSessionStateRepository;
  audit(eventType: string, entityId: string, payload: unknown): Promise<void>;
  manageRemoteThread(
    session: AgentSession,
    operation: "name" | "archive" | "unarchive",
    signal?: AbortSignal,
  ): Promise<boolean>;
};

/** Collects provider metadata without mutating or persisting an application record. */
export async function collectCodexSessionBaseline(
  deps: CodexSessionDeps,
): Promise<{ files: string[]; baseline: string }> {
  const files = await codexSessionFiles(deps);
  const ids = files.map((file) => codexMeta(file)?.session_id).filter((value): value is string => Boolean(value));
  return { files, baseline: JSON.stringify({ codexSessions: ids }) };
}

export async function discoverCodexSessionId(
  deps: CodexSessionDeps,
  startedAt: number,
  runDir: string,
  sessionId: string,
  endedAt?: number,
): Promise<CodexDiscoveryResult> {
  const session = await runEffectAsPromise(deps.sessions.findById(AgentSessionId.create(sessionId)));
  const state = await deps.state.find(AgentSessionId.create(sessionId));
  const logger = deps.logger.child({ sessionId, backend: "codex" });
  const discoveryStartedAt = Date.now();
  logger.debug("codex.session_id_discovery_started", { remote: Boolean(state?.remote) });
  const baseline = new Set<string>(readCodexBaseline(state?.sessionBaseline));
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
  session: AgentSession | undefined,
  runDir: string,
): Promise<CodexSessionCandidate[]> {
  if (!session) return candidates;
  const sessions = await runEffectAsPromise(deps.sessions.list(session.workspaceId));
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
  session: AgentSession,
  runDir: string,
): Promise<CodexDiscoveryResult> {
  const lastActivityAt = session.lastExitStatus === undefined ? Number.NaN : Date.parse(session.lastActivityAt);
  const result = await discoverCodexSessionId(
    deps,
    0,
    runDir,
    session.id,
    Number.isFinite(lastActivityAt) ? lastActivityAt / 1_000 : undefined,
  );
  if (result.candidates.length === 1) return { ...result, selectedId: result.candidates[0]?.id };
  const ownershipRejected =
    (result.diagnostics.rejected.known_to_other_session ?? 0) + (result.diagnostics.rejected.competing_session ?? 0);
  if (result.candidates.length > 1 || ownershipRejected > 0) {
    deps.logger.warn("codex.session_id_recovery_ambiguous", {
      sessionName: session.name,
      candidateFileCount: result.diagnostics.candidateFiles,
      diagnostics: result.diagnostics,
    });
  } else {
    deps.logger.warn("codex.session_id_recovery_missing", {
      sessionName: session.name,
      diagnostics: result.diagnostics,
    });
  }
  return { ...result, selectedId: undefined };
}

export async function repairCodexSessionId(
  deps: CodexSessionDeps,
  session: AgentSession,
  runDir: string,
  phase: "run" | "resume",
): Promise<AgentSession> {
  if (session.backend !== "codex" || session.backendSessionId) return session;
  const result = await recoverCodexSessionId(deps, session, runDir);
  if (!result.selectedId) {
    await deps.audit("agent_session.codex_session_id_recovery_failed", session.id, {
      name: session.name,
      phase,
      runDir,
      diagnostics: result.diagnostics,
    });
    return session;
  }
  await runEffectAsPromise(deps.sessions.setBackendSessionIdIfMissing(session.id, result.selectedId));
  const persisted = await runEffectAsPromise(deps.sessions.findById(session.id));
  if (!persisted?.backendSessionId)
    throw new ApplicationError(
      "codex_session_lost",
      `session '${session.name}' disappeared while repairing its backend session ID`,
    );
  deps.logger.info("codex.session_id_recovered", { sessionName: session.name, phase });
  return persisted;
}

export async function reportCodexDiscoveryFailure(
  deps: CodexSessionDeps,
  session: AgentSession,
  runDir: string,
  phase: "cleanup" | "finalize" | "resume" | "run",
  result: CodexDiscoveryResult,
): Promise<void> {
  const diagnostics = formatCodexDiscoveryDiagnostics(result.diagnostics);
  deps.logger.warn("codex.session_id_missing", {
    sessionName: session.name,
    phase,
    runDir,
    diagnostics: result.diagnostics,
    formattedDiagnostics: diagnostics,
  });
  await deps.audit("agent_session.codex_session_id_missing", session.id, {
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
    diagnostics.payloadMetadataFiles += 1;
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
  session: AgentSession,
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
            session.update({ backendSessionId: discovery.selectedId }),
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
