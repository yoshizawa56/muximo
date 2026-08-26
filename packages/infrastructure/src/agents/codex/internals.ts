import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";

// Shared codex session-file vocabulary and pure helpers.
export type CodexDiscoveryResult = {
  selectedId?: string;
  candidates: CodexSessionCandidate[];
  diagnostics: CodexDiscoveryDiagnostics;
};

export type CodexDiscoveryRejection =
  | "stat_error"
  | "read_error"
  | "metadata_too_large"
  | "invalid_json"
  | "not_session_meta"
  | "missing_session_id"
  | "before_started_at"
  | "cwd_mismatch"
  | "unsupported_originator"
  | "subagent"
  | "baseline"
  | "after_session_updated_at"
  | "known_to_other_session"
  | "competing_session";

export type CodexDiscoveryDiagnostics = {
  rootExists: boolean;
  filesScanned: number;
  sessionMetaFiles: number;
  payloadMetadataFiles: number;
  baselineEntries: number;
  candidateFiles: number;
  uniqueCandidates: number;
  elapsedMs: number;
  rejected: Partial<Record<CodexDiscoveryRejection, number>>;
};

export type CodexMeta = {
  session_id?: string;
  id?: string;
  cwd?: string;
  originator?: string;
  thread_source?: string;
};

export type CodexMetaInspection = {
  meta?: CodexMeta;
  rejection?: "read_error" | "metadata_too_large" | "invalid_json" | "not_session_meta";
};

export type CodexSessionCandidate = {
  id: string;
  mtime: number;
  rolloutIdMatches: boolean;
};
export function readFirstLine(file: string): { line?: string; tooLarge: boolean } {
  const maximumBytes = 1_048_576;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const buffer = Buffer.allocUnsafe(8_192);
    while (totalBytes < maximumBytes) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return { line: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
      }
      chunks.push(Buffer.from(chunk));
      totalBytes += bytesRead;
    }
    if (totalBytes >= maximumBytes) return { tooLarge: true };
    return { line: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function codexMeta(file: string): CodexMeta | undefined {
  return inspectCodexMeta(file).meta;
}

export function readCodexBaseline(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Codex session baseline is not valid JSON", { cause: error });
  }
  const sessions = isRecord(parsed) && Object.keys(parsed).length === 1 ? parsed.codexSessions : undefined;
  if (!Array.isArray(sessions) || !sessions.every((session) => typeof session === "string" && session.length > 0)) {
    throw new Error("Codex session baseline must contain codexSessions as an array of non-empty strings");
  }
  return sessions;
}

export function preferredCodexSessionId(candidates: CodexSessionCandidate[]): string | undefined {
  return candidates.find((candidate) => candidate.rolloutIdMatches)?.id ?? candidates[0]?.id;
}

export function emptyCodexDiscoveryDiagnostics(rootExists: boolean): CodexDiscoveryDiagnostics {
  return {
    rootExists,
    filesScanned: 0,
    sessionMetaFiles: 0,
    payloadMetadataFiles: 0,
    baselineEntries: 0,
    candidateFiles: 0,
    uniqueCandidates: 0,
    elapsedMs: 0,
    rejected: {},
  };
}

export function formatCodexDiscoveryDiagnostics(diagnostics: CodexDiscoveryDiagnostics): string {
  const rejected =
    Object.entries(diagnostics.rejected)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, count]) => `${reason}=${count}`)
      .join(",") || "none";
  return `rollout scan: root=${diagnostics.rootExists ? "present" : "missing"}, files=${diagnostics.filesScanned}, session_meta=${diagnostics.sessionMetaFiles}, payload=${diagnostics.payloadMetadataFiles}, baseline_entries=${diagnostics.baselineEntries}, candidate_files=${diagnostics.candidateFiles}, unique_candidates=${diagnostics.uniqueCandidates}, rejected=${rejected}, scan_ms=${diagnostics.elapsedMs}`;
}

export function inspectCodexMeta(file: string): CodexMetaInspection {
  let firstLine: { line?: string; tooLarge: boolean };
  try {
    firstLine = readFirstLine(file);
  } catch {
    return { rejection: "read_error" };
  }
  if (firstLine.tooLarge) return { rejection: "metadata_too_large" };
  if (firstLine.line === undefined) return { rejection: "read_error" };
  try {
    const parsed = JSON.parse(firstLine.line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { rejection: "invalid_json" };
    const record = parsed as Record<string, unknown>;
    if (record.type !== "session_meta") return { rejection: "not_session_meta" };
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { rejection: "not_session_meta" };
    const metadata = payload as Record<string, unknown>;
    return {
      meta: {
        session_id: stringValue(metadata.session_id),
        id: stringValue(metadata.id),
        cwd: stringValue(metadata.cwd),
        originator: stringValue(metadata.originator),
        thread_source: stringValue(metadata.thread_source),
      },
    };
  } catch {
    return { rejection: "invalid_json" };
  }
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export const supportedCodexOriginators = new Set([
  "codex-tui",
  "codex_cli_rs",
  "codex_exec",
  "codex_chatgpt_ios_remote",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clean TypeScript implementation of the dotfiles `muximo` wrapper.
 *
 * The command deliberately keeps lifecycle state in SQLite instead of shell
 * state files. It owns the backend process, managed git worktree, workspace
 * hooks, resume metadata, and Codex Remote Control lifecycle as one unit.
 */
