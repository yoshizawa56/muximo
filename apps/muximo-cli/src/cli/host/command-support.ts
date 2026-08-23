import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentBackend, AgentSessionRecord, WorkspaceRecord } from "@muximo/domain";
import {
  AgentSession,
  type AgentSessionUpdateInput,
  clearPatch,
  InvalidAgentSessionNameError,
  normalizeAgentSessionName,
  type Patch,
} from "@muximo/domain";
import { errorFields, type Logger, resolveMuximodPaths } from "@muximo/infrastructure";
import {
  type CodexDiscoveryDiagnostics,
  type CodexMeta,
  type CodexMetaInspection,
  type CodexSessionCandidate,
  type ProcessResult,
  _sessionNamePattern as sessionNamePattern,
  type TmuxNewSessionOptions,
} from "./muximo-command.js";
import { PairingControlError } from "./muximod-pairing-control-adapter.js";
import type { SessionListProjection } from "./session-list.js";

export class MuximoCommandError extends Error {}

export function toWorkspacePatch(value: string | null | undefined): Patch<string> {
  return value === null ? clearPatch : value;
}

export function buildRunCommand(
  session: AgentSessionRecord,
  backendArgs: string[],
  defaultRemote: string,
  backendBinary: string,
): string[] {
  if (session.backend === "codex") {
    const args = [backendBinary];
    if (session.codexProfile && !hasOption("--profile", backendArgs) && !hasOption("-p", backendArgs))
      args.push("--profile", session.codexProfile);
    const remote = codexRemoteEndpoint(backendArgs, defaultRemote);
    if (remote && !hasOption("--remote", backendArgs)) args.push("--remote", remote);
    const runDir = session.worktreePath ?? session.workspaceRoot;
    if (remote && !hasOption("--cd", backendArgs) && !hasOption("-C", backendArgs)) args.push("--cd", runDir);
    args.push(...backendArgs);
    return args;
  }
  const args = [backendBinary];
  if (!hasOption("--name", backendArgs) && !hasOption("-n", backendArgs)) args.push("--name", session.name);
  if (!hasOption("--session-id", backendArgs)) args.push("--session-id", session.backendSessionId ?? "");
  if (!hasOption("--permission-mode", backendArgs) && !hasOption("--dangerously-skip-permissions", backendArgs))
    args.push("--permission-mode", "auto");
  args.push(...backendArgs);
  return args;
}

export function buildResumeCommand(
  session: AgentSessionRecord,
  backendArgs: string[],
  defaultRemote: string,
  backendBinary: string,
): string[] {
  if (!session.backendSessionId) throw new MuximoCommandError("backend session ID is required to resume");
  if (session.backend === "codex") {
    const full = buildRunCommand(
      AgentSession.update(session, { backendSessionId: clearPatch }),
      backendArgs,
      session.codexRemote ?? defaultRemote,
      backendBinary,
    );
    const backendStart = full.length - backendArgs.length;
    return [...full.slice(0, backendStart), "resume", session.backendSessionId, ...backendArgs];
  }
  return [backendBinary, "--resume", session.backendSessionId, ...backendArgs];
}

export function updateSession(session: AgentSessionRecord, changes: AgentSessionUpdateInput): AgentSessionRecord {
  return AgentSession.update(session, { ...changes, updatedAt: timestamp() });
}

export function emptyWorktree(): Pick<AgentSessionRecord, "worktreeRoot" | "worktreePath" | "branch" | "baseCommit"> {
  return {};
}

export function sessionHealthLabel(health: SessionListProjection["executionHealth"]): string {
  return health === "inactive" ? "-" : health.replaceAll("_", "-");
}

export function sessionResumeLabel(resume: SessionListProjection["resume"]): string {
  if (resume === "available") return "yes";
  if (resume === "unavailable") return "no";
  return "?";
}

export function toSessionJson(view: SessionListProjection): Record<string, unknown> {
  const { session } = view;
  return {
    id: session.id,
    name: session.name,
    backend: session.backend,
    status: session.status,
    health: view.executionHealth,
    resume: view.resume,
    resume_reason: view.resumeReason,
    workspace: session.workspaceRoot,
    workspace_id: session.workspaceId,
    workspace_name: session.workspaceName,
    worktree: session.worktreePath,
    worktree_state: view.worktreeState,
    branch: session.branch,
    session_id: session.backendSessionId,
    updated_at: session.updatedAt,
  };
}

export function toWorkspaceJson(workspace: WorkspaceRecord): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    directory: workspace.rootPath,
    is_git: workspace.isGit,
    setup_hook: workspace.setupScriptPath,
    cleanup_hook: workspace.cleanupScriptPath,
    worktree_copy_patterns: workspace.worktreeCopyPatterns,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  };
}

export function workspaceAddUsage(command: string): string {
  return `Usage: muximo workspace ${command} DIRECTORY [--name NAME] [--setup-hook PATH] [--cleanup-hook PATH] [--copy-pattern PATTERN]\n`;
}

export function workspaceUpdateUsage(): string {
  return "Usage: muximo workspace update WORKSPACE [--name NAME] [--setup-hook PATH|--no-setup-hook] [--cleanup-hook PATH|--no-cleanup-hook] [--copy-pattern PATTERN|--clear-copy-patterns]\n";
}

export function resolveFromRoot(value: string, root: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

export function displayWorkspacePath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

export function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function realpathAfterMkdir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSafe(path);
}

export function timestamp(): string {
  return new Date().toISOString();
}

export type SessionPaneAdoption = {
  agentSessionId: string;
  tmuxPaneId: string;
  executionId: string;
};

export function currentTmuxPane(env: NodeJS.ProcessEnv): string | undefined {
  const pane = env.TMUX && env.TMUX_PANE ? env.TMUX_PANE.trim() : "";
  return /^%[0-9]+$/.test(pane) ? pane : undefined;
}

export function defaultControlSocket(env: NodeJS.ProcessEnv, databaseFile: string): string {
  return resolveMuximodPaths(env, { databaseFile }).controlSocket;
}

export function isControlSocketUnavailable(error: unknown): boolean {
  if (error instanceof PairingControlError) return error.code.startsWith("control_socket_");
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function setFallbackSessionMetadata(env: NodeJS.ProcessEnv, input: SessionPaneAdoption): void {
  runTmuxMetadataCommand(env, [
    "set-option",
    "-p",
    "-t",
    input.tmuxPaneId,
    "@muximod.agent_execution_id",
    input.executionId,
  ]);
  runTmuxMetadataCommand(env, [
    "set-option",
    "-p",
    "-t",
    input.tmuxPaneId,
    "@muximod.agent_session_id",
    input.agentSessionId,
  ]);
}

export function clearFallbackSessionMetadata(env: NodeJS.ProcessEnv, input: SessionPaneAdoption): boolean {
  const current = runTmuxMetadataCommand(env, [
    "show-options",
    "-q",
    "-p",
    "-v",
    "-t",
    input.tmuxPaneId,
    "@muximod.agent_execution_id",
  ]);
  if (current.status !== 0 || current.stdout.trim() !== input.executionId) return false;
  runTmuxMetadataCommand(env, ["set-option", "-p", "-u", "-t", input.tmuxPaneId, "@muximod.agent_execution_id"]);
  runTmuxMetadataCommand(env, ["set-option", "-p", "-u", "-t", input.tmuxPaneId, "@muximod.agent_session_id"]);
  return true;
}

export function runTmuxMetadataCommand(
  env: NodeJS.ProcessEnv,
  args: string[],
): { status: number | null; stdout: string } {
  const socket = env.TMUX?.split(",", 1)[0] ?? env.MUXIMOD_TMUX_SOCKET;
  try {
    const result = spawnSync("tmux", [...(socket ? ["-S", socket] : []), ...args], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { status: result.status, stdout: result.stdout ?? "" };
  } catch {
    return { status: null, stdout: "" };
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function localTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function requireOptionValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new MuximoCommandError(`${option} requires a value`);
  return value;
}

export function hasHelpBeforeDelimiter(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === "-h" || argument === "--help") return true;
  }
  return false;
}

export function parseTmuxNewSessionOptions(args: string[], defaultCwd: string): TmuxNewSessionOptions {
  let name = "muximod";
  let cwd = defaultCwd;
  let detached = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-s" || argument === "--name") name = requireOptionValue(argument, args[++index]);
    else if (argument.startsWith("--name=")) name = argument.slice("--name=".length);
    else if (argument === "-c" || argument === "--cwd")
      cwd = resolveFromRoot(requireOptionValue(argument, args[++index]), defaultCwd);
    else if (argument.startsWith("--cwd=")) cwd = resolveFromRoot(argument.slice("--cwd=".length), defaultCwd);
    else if (argument === "-d" || argument === "--detached") detached = true;
    else throw new MuximoCommandError(`unknown tmux new-session option: ${argument}`);
  }

  validateSessionName(name);
  if (!existsSync(cwd)) throw new MuximoCommandError(`tmux session cwd does not exist: ${cwd}`);
  return { name, cwd: realpathSafe(cwd), detached };
}

export function _shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateSessionName(name: string): void {
  if (!sessionNamePattern.test(name))
    throw new MuximoCommandError(`invalid session name '${name}'; use 1-64 letters, digits, '.', '_' or '-'`);
}

export function normalizeSessionName(value: string): string {
  try {
    const name = normalizeAgentSessionName(value);
    validateSessionName(name);
    return name;
  } catch (error) {
    if (error instanceof InvalidAgentSessionNameError) throw new MuximoCommandError(error.message);
    throw error;
  }
}

export function gitWorkspaceRoot(cwd: string): string | undefined {
  try {
    return realpathSafe(
      execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }
}

export function gitRequired(cwd: string, args: string[], message: string): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new MuximoCommandError(message);
  }
}

export function gitOutputRaw(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

export function listUnmanagedFiles(cwd: string): string[] {
  const files = new Set<string>();
  for (const args of [
    ["ls-files", "--others", "--exclude-standard", "-z"],
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
  ]) {
    for (const file of gitOutputRaw(cwd, args).split("\u0000")) {
      if (file) files.add(file);
    }
  }
  return [...files];
}

export function matchesWorktreeCopyPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/");
  const pathSegments = path.split("/");
  const memo = new Map<string, boolean>();

  const match = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      result =
        match(patternIndex + 1, pathIndex) || (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    } else {
      result =
        pathIndex < pathSegments.length &&
        matchSegmentPattern(patternSegments[patternIndex]!, pathSegments[pathIndex]!) &&
        match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

export function matchSegmentPattern(pattern: string, value: string): boolean {
  let expression = "^";
  for (const character of pattern) {
    if (character === "*") expression += ".*";
    else expression += /[.\\+^$()|[\]{}]/.test(character) ? `\\${character}` : character;
  }
  return new RegExp(`${expression}$`).test(value);
}

export function isPathWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

export function gitOutputOrEmpty(cwd: string, args: string[]): string {
  return gitOutputRaw(cwd, args).trim();
}

export function gitStatusCode(cwd: string, args: string[]): number {
  return spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" }).status ?? 1;
}

export function commandPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return (
      execFileSync("which", [command], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export function resolveBackendCommand(backend: AgentBackend, env: NodeJS.ProcessEnv): string {
  const override =
    backend === "codex" ? "MUXIMO_CODEX_BIN" : backend === "claude" ? "MUXIMO_CLAUDE_BIN" : "MUXIMO_OPENCODE_BIN";
  return resolveExecutable(env[override] ?? backend, env);
}

export function resolveExecutable(value: string, env: NodeJS.ProcessEnv): string {
  if (value.includes("/")) {
    accessSync(value, constants.X_OK);
    return value;
  }
  const path = commandPath(value, env);
  if (!path) throw new MuximoCommandError(`backend executable not found: ${value}`);
  return path;
}

export async function ensureCodexRemoteControl(
  backend: AgentBackend,
  args: string[],
  binary: string,
  defaultRemote: string,
  env: NodeJS.ProcessEnv,
  logger?: Logger,
): Promise<void> {
  if (backend !== "codex" || !codexRemoteEndpoint(args, defaultRemote)) return;
  logger?.debug("codex.remote_control_starting", {
    executable: basename(binary),
    remoteConfigured: true,
  });
  for (const command of [
    ["app-server", "daemon", "enable-remote-control"],
    ["app-server", "daemon", "start"],
  ]) {
    const startedAt = Date.now();
    logger?.debug("codex.remote_control_command_started", {
      executable: basename(binary),
      operation: command.join("."),
    });
    const result = spawnSync(binary, command, { stdio: "ignore", env });
    logger?.debug("codex.remote_control_command_finished", {
      executable: basename(binary),
      operation: command.join("."),
      exitCode: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
    });
    if (result.status !== 0) {
      logger?.debug("codex.remote_control_failed", {
        executable: basename(binary),
        operation: command.join("."),
        exitCode: result.status,
      });
      throw new MuximoCommandError(`could not run Codex app-server command: ${command.join(" ")}`);
    }
  }
  logger?.debug("codex.remote_control_finished", { executable: basename(binary) });
}

export type SpawnHooks = {
  onStarted?: (pid: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export async function spawnAttached(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  hooks: SpawnHooks = {},
): Promise<ProcessResult> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(binary, args, { cwd, env, stdio: "inherit" });
  } catch (error) {
    hooks.onError?.(error);
    return { code: 127, interrupted: false };
  }
  let interrupted = false;
  const onInterrupt = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const started = new Promise<boolean>((resolvePromise) => {
    child.once("spawn", () => resolvePromise(true));
    child.once("error", () => resolvePromise(false));
  });
  const result = new Promise<ProcessResult>((resolvePromise) => {
    child.once("error", (error) => {
      hooks.onError?.(error);
      resolvePromise({ code: 127, interrupted, pid: child.pid, signal: null });
    });
    child.once("close", (code, signal) =>
      resolvePromise({
        code: code ?? signalExitCode(signal),
        interrupted,
        pid: child.pid,
        signal,
      }),
    );
  });
  try {
    if (await started) await hooks.onStarted?.(child.pid);
    return await result;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

export async function runAttachedProcess(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logger?: Logger,
  kind = "attached",
): Promise<number> {
  const startedAt = Date.now();
  logger?.debug("subprocess.starting", {
    kind,
    executable: basename(binary),
    cwd,
    argumentCount: args.length,
  });
  const result = await spawnAttached(binary, args, cwd, env, {
    onStarted: (pid) =>
      logger?.debug("subprocess.started", {
        kind,
        executable: basename(binary),
        pid,
      }),
    onError: (error) =>
      logger?.debug("subprocess.spawn_failed", {
        kind,
        executable: basename(binary),
        ...errorFields(error),
      }),
  });
  logger?.debug("subprocess.finished", {
    kind,
    executable: basename(binary),
    pid: result.pid,
    exitCode: result.code,
    signal: result.signal,
    interrupted: result.interrupted,
    durationMs: Date.now() - startedAt,
  });
  return result.code;
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export function codexRemoteEndpoint(args: string[], fallback: string): string {
  return optionValue("--remote", args) ?? fallback;
}

export function hasOption(name: string, args: string[]): boolean {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

export function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function optionValue(name: string, args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    if (argument === name) return args[index + 1];
  }
  return undefined;
}

export function readCodexBaseline(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { codexSessions?: unknown };
    return Array.isArray(parsed.codexSessions)
      ? parsed.codexSessions.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
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
    flatMetadataFiles: 0,
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
  return `rollout scan: root=${diagnostics.rootExists ? "present" : "missing"}, files=${diagnostics.filesScanned}, session_meta=${diagnostics.sessionMetaFiles}, payload=${diagnostics.payloadMetadataFiles}, flat=${diagnostics.flatMetadataFiles}, baseline_entries=${diagnostics.baselineEntries}, candidate_files=${diagnostics.candidateFiles}, unique_candidates=${diagnostics.uniqueCandidates}, rejected=${rejected}, scan_ms=${diagnostics.elapsedMs}`;
}

export function codexMeta(file: string): CodexMeta | undefined {
  return inspectCodexMeta(file).meta;
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
    // Codex 0.147.0 moved session metadata under `payload`, while older
    // rollouts kept these fields at the top level. Read both shapes so
    // persisted sessions remain resumable across Codex upgrades.
    const payload = record.payload;
    const isPayload = payload && typeof payload === "object" && !Array.isArray(payload);
    const metadata = isPayload ? (payload as Record<string, unknown>) : record;
    return {
      shape: isPayload ? "payload" : "flat",
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

export function runCodexThreadHelper(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolvePromise) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let killTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const terminate = (): void => {
      child?.kill("SIGTERM");
      killTimeout = setTimeout(() => child?.kill("SIGKILL"), 250);
    };
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      signal?.removeEventListener("abort", terminate);
      resolvePromise(status);
    };
    try {
      child = spawn(executable, args, { stdio: "ignore", env });
    } catch {
      finish(127);
      return;
    }
    child.once("error", () => finish(127));
    child.once("close", (status) => finish(status ?? 1));
    signal?.addEventListener("abort", terminate, { once: true });
    if (signal?.aborted) terminate();
    timeout = setTimeout(terminate, 2_000);
  });
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

export function unlinkEmptyDirectory(path: string | null | undefined): void {
  if (!path) return;
  try {
    const entries = readdirSync(path);
    if (entries.length === 0) {
      // rmdir is intentionally limited to the exact managed worktree root.
      execFileSync("rmdir", [path], { stdio: "ignore" });
    }
  } catch {
    // The root may be shared or already gone.
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function padHeader(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}

export function padRow(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}
