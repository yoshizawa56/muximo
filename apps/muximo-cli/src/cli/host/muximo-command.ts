import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  DeleteWorkspace,
  ListWorkspaces,
  RegisterWorkspace,
  UpdateWorkspace,
  WorkspaceRecordFactory,
} from "@muximo/application";
import type { AgentBackend, AgentSessionRecord, PaneState, WorkspaceRecord } from "@muximo/domain";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  isValidWorktreeCopyPattern,
  normalizeAgentSessionName,
  normalizeWorktreeCopyPatterns,
  WorkspaceId,
} from "@muximo/domain";
import {
  type AgentDatabase,
  type AgentMonitor,
  type AgentObservation,
  type AgentPluginRegistry,
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  createAgentDatabase,
  createDefaultAgentPluginRegistry,
  createLogger,
  DrizzleAgentSessionRepository,
  DrizzleWorkspaceRepository,
  defaultOpenCodeRegistryFile,
  errorFields,
  type Logger,
  type LogLevel,
  OpenCodeServerManager,
  openCodeMonitorActions,
  recordAuditEvent,
  resolveMuximoCommand,
  resolveMuximodPaths,
  SqliteTransactionManager,
  TmuxAdapter,
  WorkspaceSelectionCatalog,
  workspaceIdForPath,
} from "@muximo/infrastructure";
import { manageCodexThread } from "./codex-remote.js";
import {
  buildResumeCommand,
  buildRunCommand,
  clearFallbackSessionMetadata,
  codexMeta,
  codexRemoteEndpoint,
  currentTmuxPane,
  defaultControlSocket,
  emptyCodexDiscoveryDiagnostics,
  emptyWorktree,
  ensureCodexRemoteControl,
  formatCodexDiscoveryDiagnostics,
  gitOutputOrEmpty,
  gitOutputRaw,
  gitRequired,
  gitStatusCode,
  gitWorkspaceRoot,
  hasHelpBeforeDelimiter,
  hasOption,
  inspectCodexMeta,
  isControlSocketUnavailable,
  isPathWithin,
  isProcessAlive,
  listUnmanagedFiles,
  localTimestamp,
  MuximoCommandError,
  matchesWorktreeCopyPattern,
  normalizeSessionName,
  optionValue,
  parseTmuxNewSessionOptions,
  preferredCodexSessionId,
  readCodexBaseline,
  realpathAfterMkdir,
  realpathSafe,
  requireOptionValue,
  resolveBackendCommand,
  resolveExecutable,
  resolveFromRoot,
  runAttachedProcess,
  runCodexThreadHelper,
  setFallbackSessionMetadata,
  sleep,
  spawnAttached,
  stringEnvironment,
  timestamp,
  unlinkEmptyDirectory,
  updateSession,
  walkFiles,
} from "./command-support.js";
import { runDoctor } from "./commands/doctor.js";
import {
  listSessions as executeListSessions,
  parseListOptions as parseListOptionsArgs,
} from "./commands/list-sessions.js";
import { confirmCleanup as confirmCleanupFn, runCleanupSession } from "./commands/session-lifecycle.js";
import { executeWorkspaceCommand } from "./commands/workspace-commands.js";

export { buildResumeCommand, buildRunCommand, MuximoCommandError } from "./command-support.js";

import { MuximodPairingControlAdapter } from "./muximod-pairing-control-adapter.js";

export type MuximoCommandIO = {
  out: Writable;
  err: Writable;
};

export type MuximoCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: MuximoCommandIO;
  logger?: Logger;
  logLevel?: LogLevel;
  databaseFile?: string;
  repositoryRoot?: string;
  tmux?: TmuxAdapter;
  agentPlugins?: AgentPluginRegistry;
};

type WorkspaceContext = WorkspaceRecord;

type RunOptions = {
  backend: AgentBackend;
  name?: string;
  useWorktree: boolean;
  worktreeRoot?: string;
  setupHook?: string;
  cleanupHook?: string;
  setupHookExplicit: boolean;
  cleanupHookExplicit: boolean;
  codexProfile?: string;
  backendArgs: string[];
};

type ResumeOptions = {
  global: boolean;
  reference: string;
  backendArgs: string[];
};

export type ProcessResult = {
  code: number;
  interrupted: boolean;
  pid?: number;
  signal?: NodeJS.Signals | null;
};

type BackendLaunch = {
  command: string[];
  monitor?: AgentMonitor;
  /** Durable backend session ID produced during preparation (OpenCode). */
  backendSessionId?: string | null;
  /** Abort the backend session when the primary process is interrupted. */
  abortSession?: () => Promise<void>;
};

export type CodexSessionCandidate = {
  id: string;
  mtime: number;
  rolloutIdMatches: boolean;
};

type CodexDiscoveryRejection =
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
  flatMetadataFiles: number;
  baselineEntries: number;
  candidateFiles: number;
  uniqueCandidates: number;
  elapsedMs: number;
  rejected: Partial<Record<CodexDiscoveryRejection, number>>;
};

type CodexDiscoveryResult = {
  selectedId?: string;
  candidates: CodexSessionCandidate[];
  diagnostics: CodexDiscoveryDiagnostics;
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
  shape?: "payload" | "flat";
  rejection?: "read_error" | "metadata_too_large" | "invalid_json" | "not_session_meta";
};

type ShellOptions = {
  shell?: string;
  command: string[];
  exitAfterCommand: boolean;
  worktree: boolean;
  worktreeName: string | null;
};

export type TmuxNewSessionOptions = {
  name: string;
  cwd: string;
  detached: boolean;
};

/**
 * Self-contained worktree lifecycle for `muximo shell --worktree`. The shell
 * creates the worktree, runs copy patterns and the setup hook, then removes
 * the worktree and runs the cleanup hook on exit. No AgentSession record is
 * persisted; the process owns everything it creates.
 */
type WorktreeShellContext = {
  name: string;
  workspaceRoot: string;
  worktreeRoot: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  setupHook: string | null;
  cleanupHook: string | null;
  worktreeCopyPatterns: readonly string[];
};

type SessionListOptions = {
  global: boolean;
  names: boolean;
  json: boolean;
  all: boolean;
};

export type GitWorktreeRegistry = { ok: true; paths: ReadonlySet<string> } | { ok: false };

export const _sessionNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,63}$/u;
const supportedCodexOriginators = new Set(["codex-tui", "codex_cli_rs", "codex_exec", "codex_chatgpt_ios_remote"]);

/**
 * Clean TypeScript implementation of the dotfiles `muximo` wrapper.
 *
 * The command deliberately keeps lifecycle state in SQLite instead of shell
 * state files. It owns the backend process, managed git worktree, workspace
 * hooks, resume metadata, and Codex Remote Control lifecycle as one unit.
 */
export class MuximoCommand {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly io: MuximoCommandIO;
  private readonly repositoryRoot: string;
  private readonly hookOutputRoot: string;
  private readonly defaultCodexRemote: string;
  private readonly databaseFile: string;
  private readonly instanceDirectory: string | undefined;
  private readonly tmux: TmuxAdapter;
  private readonly logger: Logger;
  private readonly ownsLogger: boolean;
  private readonly agentPlugins: AgentPluginRegistry;
  private activeLogger: Logger | undefined;
  private remoteOperation: Promise<void> = Promise.resolve();
  private database: AgentDatabase | undefined;
  private transactionManager: SqliteTransactionManager | undefined;
  private sessions!: DrizzleAgentSessionRepository;
  private workspaces!: DrizzleWorkspaceRepository;
  private workspaceCatalog!: WorkspaceSelectionCatalog;
  private workspaceList!: ListWorkspaces;
  private workspaceRegister!: RegisterWorkspace;
  private workspaceUpdate!: UpdateWorkspace;
  private workspaceDelete!: DeleteWorkspace;

  public constructor(options: MuximoCommandOptions = {}) {
    this.cwd = realpathSafe(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...options.env };
    this.io = options.io ?? { out: process.stdout, err: process.stderr };
    this.ownsLogger = !options.logger;
    this.logger =
      options.logger ??
      createLogger({
        service: "muximo-cli",
        mode: "attached",
        level: options.logLevel ?? "warn",
        output: this.io.err,
        showStack: options.logLevel === "debug",
      });
    this.agentPlugins = options.agentPlugins ?? createDefaultAgentPluginRegistry();
    this.repositoryRoot = options.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const paths = resolveMuximodPaths(this.env, { databaseFile: options.databaseFile });
    this.hookOutputRoot = resolveFromRoot(paths.hookOutputDirectory, this.repositoryRoot);
    this.defaultCodexRemote = this.env.MUXIMO_CODEX_REMOTE === undefined ? "unix://" : this.env.MUXIMO_CODEX_REMOTE;
    this.databaseFile = options.databaseFile ?? paths.databaseFile;
    const configuredDatabaseFile = options.databaseFile ?? this.env.MUXIMOD_DB_FILE ?? this.env.MUXIMO_DATABASE_FILE;
    this.instanceDirectory =
      this.databaseFile === ":memory:" || (configuredDatabaseFile?.trim() && !this.env.MUXIMOD_INSTANCE_DIR?.trim())
        ? undefined
        : paths.instanceDirectory;
    this.tmux = options.tmux ?? new TmuxAdapter(this.env.MUXIMOD_TMUX_SOCKET, undefined, this.env);
  }

  public close(): void {
    this.transactionManager?.close();
    this.database?.close();
    if (this.ownsLogger) this.logger.close();
  }

  private get currentLogger(): Logger {
    return this.activeLogger ?? this.logger;
  }

  public async execute(args: string[]): Promise<number> {
    const [command = ""] = args;
    const logger = this.logger.child({ invocationId: randomUUID(), command: command || "help" });
    const startedAt = Date.now();
    logger.debug("command.started", { argumentCount: args.length });
    const previousLogger = this.activeLogger;
    this.activeLogger = logger;
    try {
      let status: number;
      switch (command) {
        case "run": {
          const backend = args[1];
          if (backend !== "codex" && backend !== "claude" && backend !== "opencode")
            throw new MuximoCommandError("run requires codex, claude, or opencode");
          status = await this.runSession(backend, this.parseRunOptions(backend, args.slice(2)));
          break;
        }
        case "shell":
          if (args.includes("-h") || args.includes("--help")) {
            this.write(
              "Usage: muximo shell [--shell PATH] [--worktree [NAME]] [--exit-after-command] [-- COMMAND...]\n",
            );
            status = 0;
            break;
          }
          status = await this.runShell(this.parseShellOptions(args.slice(1)));
          break;
        case "tmux":
          status = await this.runTmux(args.slice(1));
          break;
        case "workspace":
          this.ensureDatabase();
          status = await this.runWorkspaceCommand(args.slice(1));
          break;
        case "session":
          this.ensureDatabase();
          status = await this.runSessionCommand(args.slice(1));
          break;
        case "resume":
          if (args[1] === "-h" || args[1] === "--help") {
            this.write("Usage: muximo resume [--global] NAME [-- BACKEND_ARGS...]\n");
            status = 0;
            break;
          }
          this.ensureDatabase();
          status = await this.resumeSession(this.parseResumeOptions(args.slice(1)));
          break;
        case "list":
          if (args.includes("-h") || args.includes("--help")) {
            this.write("Usage: muximo list [--global] [--all] [--names|--json]\n");
            status = 0;
            break;
          }
          this.ensureDatabase();
          status = await this.listSessions(this.parseListOptions(args.slice(1)));
          break;
        case "cleanup":
          if (args.includes("-h") || args.includes("--help")) {
            this.write("Usage: muximo cleanup [--global] [--force] NAME\n");
            status = 0;
            break;
          }
          this.ensureDatabase();
          status = await this.cleanupSession(this.parseCleanupOptions(args.slice(1)));
          break;
        case "doctor":
          if (args.includes("-h") || args.includes("--help")) {
            this.write("Usage: muximo doctor [--verbose]\n");
            status = 0;
            break;
          }
          status = await this.doctor(this.parseDoctorOptions(args.slice(1)));
          break;
        case "help":
        case "--help":
        case "-h":
          this.printUsage();
          status = 0;
          break;
        default:
          this.printUsage();
          status = 2;
          break;
      }
      logger.debug("command.finished", { status, durationMs: Date.now() - startedAt });
      return status;
    } catch (error) {
      logger.debug("command.failed", {
        durationMs: Date.now() - startedAt,
        ...errorFields(error),
      });
      throw error;
    } finally {
      this.activeLogger = previousLogger;
    }
  }

  private parseRunOptions(backend: AgentBackend, args: string[]): RunOptions {
    let name: string | undefined;
    let useWorktree = false;
    let worktreeRoot: string | undefined;
    let setupHook: string | undefined;
    let cleanupHook: string | undefined;
    let setupHookExplicit = false;
    let cleanupHookExplicit = false;
    let codexProfile = this.env.MUXIMO_CODEX_PROFILE || undefined;
    const backendArgs: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--") {
        backendArgs.push(...args.slice(index + 1));
        break;
      }
      if (argument === "-n" || argument === "--name") {
        name = requireOptionValue(argument, args[++index]);
      } else if (argument.startsWith("--name=")) {
        name = argument.slice("--name=".length);
      } else if (argument === "-w" || argument === "--worktree") {
        useWorktree = true;
        const next = args[index + 1];
        if (next && !next.startsWith("-")) {
          if (name) throw new MuximoCommandError("worktree name was specified more than once");
          name = next;
          index += 1;
        }
      } else if (argument.startsWith("--worktree=")) {
        useWorktree = true;
        if (name) throw new MuximoCommandError("worktree name was specified more than once");
        name = argument.slice("--worktree=".length);
      } else if (argument === "--no-worktree") {
        useWorktree = false;
      } else if (argument === "--worktree-root") {
        worktreeRoot = requireOptionValue(argument, args[++index]);
      } else if (argument.startsWith("--worktree-root=")) {
        worktreeRoot = argument.slice("--worktree-root=".length);
      } else if (argument === "--setup-hook") {
        setupHook = requireOptionValue(argument, args[++index]);
        setupHookExplicit = true;
      } else if (argument.startsWith("--setup-hook=")) {
        setupHook = argument.slice("--setup-hook=".length);
        setupHookExplicit = true;
      } else if (argument === "--cleanup-hook") {
        cleanupHook = requireOptionValue(argument, args[++index]);
        cleanupHookExplicit = true;
      } else if (argument.startsWith("--cleanup-hook=")) {
        cleanupHook = argument.slice("--cleanup-hook=".length);
        cleanupHookExplicit = true;
      } else if (argument === "--no-setup-hook") {
        setupHook = undefined;
        setupHookExplicit = true;
      } else if (argument === "--no-cleanup-hook") {
        cleanupHook = undefined;
        cleanupHookExplicit = true;
      } else if (
        argument === "--setup-task" ||
        argument === "--cleanup-task" ||
        argument.startsWith("--setup-task=") ||
        argument.startsWith("--cleanup-task=")
      ) {
        throw new MuximoCommandError(
          `${argument} is no longer supported; use workspace hooks or --setup-hook/--cleanup-hook`,
        );
      } else if (argument === "--codex-profile") {
        codexProfile = requireOptionValue(argument, args[++index]);
      } else if (argument.startsWith("--codex-profile=")) {
        codexProfile = argument.slice("--codex-profile=".length);
      } else if (argument === "-p" && backend !== "codex") {
        backendArgs.push(argument);
      } else if (argument === "-p" || argument === "--profile") {
        const value = requireOptionValue(argument, args[++index]);
        backendArgs.push(argument, value);
        if (backend === "codex") codexProfile = value;
      } else if (argument.startsWith("--profile=")) {
        backendArgs.push(argument);
        if (backend === "codex") codexProfile = argument.slice("--profile=".length);
      } else {
        backendArgs.push(argument);
      }
    }

    return {
      backend,
      name,
      useWorktree,
      worktreeRoot,
      setupHook,
      cleanupHook,
      setupHookExplicit,
      cleanupHookExplicit,
      codexProfile,
      backendArgs,
    };
  }

  private parseShellOptions(args: string[]): ShellOptions {
    let shell: string | undefined;
    let exitAfterCommand = false;
    let worktree = false;
    let worktreeName: string | null = null;
    let command: string[] = [];

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--") {
        command = args.slice(index + 1);
        break;
      }
      if (argument === "--shell") shell = requireOptionValue(argument, args[++index]);
      else if (argument.startsWith("--shell=")) shell = argument.slice("--shell=".length);
      else if (argument === "--exit-after-command") exitAfterCommand = true;
      else if (argument === "-w" || argument === "--worktree") {
        worktree = true;
        const next = args[index + 1];
        if (next && !next.startsWith("-")) {
          worktreeName = next;
          index += 1;
        }
      } else if (argument.startsWith("--worktree=")) {
        worktree = true;
        worktreeName = argument.slice("--worktree=".length);
      } else if (argument === "--no-worktree") {
        worktree = false;
        worktreeName = null;
      } else throw new MuximoCommandError(`unknown shell option: ${argument}`);
    }

    if (exitAfterCommand && command.length === 0)
      throw new MuximoCommandError("--exit-after-command requires a command after --");
    return { shell, command, exitAfterCommand, worktree, worktreeName };
  }

  private async runShell(options: ShellOptions): Promise<number> {
    const paneName = this.env.MUXIMOD_PANE_NAME ?? this.env.MUXIMOD_MANAGED_SESSION_NAME ?? "shell";
    const shellEnvironment: NodeJS.ProcessEnv = {
      ...this.env,
      MUXIMOD_WRAPPED_SHELL: "1",
    };
    const shellMetadataEnvironment: NodeJS.ProcessEnv = {
      ...shellEnvironment,
    };
    this.markCurrentPane({ kind: "shell", agentId: null, name: paneName }, shellMetadataEnvironment);

    let worktreeContext: WorktreeShellContext | null = null;

    try {
      let shellCwd = this.cwd;
      if (options.command.length > 0) {
        const result = await spawnAttached(options.command[0]!, options.command.slice(1), this.cwd, shellEnvironment);
        if (options.exitAfterCommand) return result.code;
        shellCwd = await this.resolveWorktreeShellCwd(shellEnvironment);
      }

      if (options.worktree) {
        this.ensureDatabase();
        const workspace = await this.resolveWorkspace();
        if (!workspace.isGit) throw new MuximoCommandError("a managed worktree requires a git workspace");
        const worktreeName = options.worktreeName ?? paneName;
        const created = this.createWorktree(workspace, worktreeName);
        const context: WorktreeShellContext = {
          name: worktreeName,
          workspaceRoot: workspace.rootPath,
          worktreeRoot: created.worktreeRoot ?? null,
          worktreePath: created.worktreePath ?? null,
          branch: created.branch ?? null,
          baseCommit: created.baseCommit ?? null,
          setupHook: workspace.setupScriptPath
            ? this.resolveHookPath(workspace.setupScriptPath, workspace.rootPath)
            : null,
          cleanupHook: workspace.cleanupScriptPath
            ? this.resolveHookPath(workspace.cleanupScriptPath, workspace.rootPath)
            : null,
          worktreeCopyPatterns: workspace.worktreeCopyPatterns,
        };
        worktreeContext = context;
        if (!(await this.copyWorktreeFiles(context, context.worktreeCopyPatterns))) {
          throw new MuximoCommandError("worktree file copy failed");
        }
        if (!(await this.runShellHook(context, "setup"))) {
          throw new MuximoCommandError("setup hook failed");
        }
        shellCwd = context.worktreePath!;
      }

      const shellBinary = resolveExecutable(options.shell ?? this.env.SHELL ?? "sh", this.env);
      const interactiveShellEnvironment: NodeJS.ProcessEnv = { ...shellEnvironment };
      delete interactiveShellEnvironment.MUXIMOD_WORKTREE_SESSION_NAME;
      return await spawnAttached(shellBinary, ["-i"], shellCwd, interactiveShellEnvironment).then(
        (result) => result.code,
      );
    } finally {
      try {
        if (worktreeContext) await this.disposeWorktreeShell(worktreeContext);
      } finally {
        this.restoreCurrentPaneMetadata(shellMetadataEnvironment);
      }
    }
  }

  private async runTmux(args: string[]): Promise<number> {
    const [subcommand = "", ...rest] = args;
    if (subcommand === "" || subcommand === "-h" || subcommand === "--help") {
      this.write("Usage: muximo tmux new-session [-s NAME] [-c PATH] [--detached]\n");
      return subcommand === "" ? 2 : 0;
    }
    if (subcommand !== "new-session") throw new MuximoCommandError(`unknown tmux command: ${subcommand}`);
    if (rest.includes("-h") || rest.includes("--help")) {
      this.write("Usage: muximo tmux new-session [-s NAME] [-c PATH] [--detached]\n");
      return 0;
    }

    const options = parseTmuxNewSessionOptions(rest, this.cwd);
    if (this.tmux.hasSession(options.name))
      throw new MuximoCommandError(`tmux session already exists: ${options.name}`);

    const managedSessionId = randomUUID();
    const binary = resolveMuximoCommand(this.env);
    const firstPaneCommand = buildMuximoShellCommand(binary, {
      MUXIMOD_MANAGED_SESSION_ID: managedSessionId,
      MUXIMOD_MANAGED_SESSION_NAME: options.name,
    });
    let created = false;
    try {
      this.tmux.createSession(options.name, options.cwd, firstPaneCommand);
      created = true;
      configureManagedTmuxSession(this.tmux, options.name, managedSessionId, binary);
    } catch (error) {
      if (created) {
        try {
          this.tmux.killSession(options.name);
        } catch {
          // Preserve the original setup error; cleanup is best effort.
        }
      }
      throw error;
    }

    this.write(`muximo: created managed tmux session '${options.name}' (${managedSessionId})\n`);
    if (options.detached) return 0;
    return this.tmux.attachSession(options.name);
  }

  private async runSessionCommand(args: string[]): Promise<number> {
    const [subcommand = "", ...rest] = args;
    if (subcommand === "" || subcommand === "-h" || subcommand === "--help") {
      this.write("Usage: muximo session <list|resume|cleanup> [OPTIONS]\n");
      return subcommand === "" ? 2 : 0;
    }

    switch (subcommand) {
      case "list":
        if (hasHelpBeforeDelimiter(rest)) {
          this.write("Usage: muximo session list [--global] [--all] [--names|--json]\n");
          return 0;
        }
        return this.listSessions(this.parseListOptions(rest));
      case "resume":
        if (hasHelpBeforeDelimiter(rest)) {
          this.write("Usage: muximo session resume [--global] NAME [-- BACKEND_ARGS...]\n");
          return 0;
        }
        return this.resumeSession(this.parseResumeOptions(rest));
      case "cleanup":
        if (hasHelpBeforeDelimiter(rest)) {
          this.write("Usage: muximo session cleanup [--global] [--force] NAME\n");
          return 0;
        }
        return this.cleanupSession(this.parseCleanupOptions(rest));
      default:
        throw new MuximoCommandError(`unknown session command: ${subcommand}`);
    }
  }

  private async runWorkspaceCommand(args: string[]): Promise<number> {
    return executeWorkspaceCommand(args, {
      write: (value) => this.write(value),
      info: (value) => this.info(value),
      workspaceList: this.workspaceList,
      workspaceRegister: this.workspaceRegister,
      workspaceUpdate: this.workspaceUpdate,
      workspaceDelete: this.workspaceDelete,
    });
  }

  private markCurrentPane(
    input: { kind: "shell" | "agent"; agentId: string | null; name: string },
    environment = this.env,
  ): void {
    const paneId = environment.TMUX_PANE;
    if (!paneId) return;
    try {
      this.tmux.setAgentPaneMetadata(paneId, "kind", input.kind);
      this.tmux.setAgentPaneMetadata(paneId, "agent_id", input.agentId ?? "");
      this.tmux.setAgentPaneMetadata(paneId, "pane_name", input.name);
      this.tmux.setAgentPaneMetadata(paneId, "managed_session_id", environment.MUXIMOD_MANAGED_SESSION_ID ?? "");
    } catch {
      // A shell can also run outside tmux or against a server that disappears
      // while the wrapper is starting. The wrapper must remain usable there.
    }
  }

  private restoreCurrentPaneMetadata(environment = this.env): void {
    this.markCurrentPane(
      {
        kind: "shell",
        agentId: null,
        name: environment.MUXIMOD_PANE_NAME ?? environment.MUXIMOD_MANAGED_SESSION_NAME ?? "shell",
      },
      environment,
    );
  }

  private parseResumeOptions(args: string[]): ResumeOptions {
    let global = false;
    let reference: string | undefined;
    const backendArgs: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "-g" || argument === "--global") {
        global = true;
      } else if (argument === "-h" || argument === "--help") {
        this.write("Usage: muximo resume [--global] NAME [-- BACKEND_ARGS...]\n");
        return { global, reference: "", backendArgs: [] };
      } else if (argument === "--") {
        backendArgs.push(...args.slice(index + 1));
        break;
      } else if (argument.startsWith("-") && !reference) {
        throw new MuximoCommandError(`unknown resume option: ${argument}`);
      } else if (!reference) {
        reference = argument;
      } else {
        backendArgs.push(argument);
      }
    }
    if (!reference) throw new MuximoCommandError("resume requires a session name");
    return { global, reference, backendArgs };
  }

  private parseListOptions(args: string[]): SessionListOptions {
    return parseListOptionsArgs({ write: (value) => this.write(value) }, args);
  }
  private async cleanupSession(options: { global: boolean; force: boolean; reference: string }): Promise<number> {
    return runCleanupSession(options, {
      env: this.env,
      logger: this.currentLogger,
      info: (value) => this.info(value),
      locateSession: (reference, global) => this.locateSession(reference, global),
      worktreeIsRegistered: (session) => this.worktreeIsRegistered(session),
      worktreeHasAgentChanges: (session) => this.worktreeHasAgentChanges(session),
      confirmCleanup: (session, dirty) => confirmCleanupFn({ env: this.env }, session, dirty),
      removeSessionRecord: (session, force) => this.removeSessionRecord(session, force),
    });
  }

  private parseCleanupOptions(args: string[]): { global: boolean; force: boolean; reference: string } {
    let global = false;
    let force = false;
    let reference = "";
    for (const argument of args) {
      if (argument === "-g" || argument === "--global") global = true;
      else if (argument === "--force") force = true;
      else if (argument === "-h" || argument === "--help") {
        this.write("Usage: muximo cleanup [--global] [--force] NAME\n");
        return { global, force, reference };
      } else if (argument.startsWith("-")) throw new MuximoCommandError(`unknown cleanup option: ${argument}`);
      else if (reference) throw new MuximoCommandError("cleanup accepts exactly one session name");
      else reference = argument;
    }
    if (!reference) throw new MuximoCommandError("cleanup requires a session name");
    return { global, force, reference };
  }
  private async doctor(options: { verbose: boolean }): Promise<number> {
    return runDoctor(options, {
      env: this.env,
      logger: this.currentLogger,
      write: (value, error) => this.write(value, error),
      databaseFile: this.databaseFile,
      defaultCodexRemote: this.defaultCodexRemote,
    });
  }

  private parseDoctorOptions(args: string[]): { verbose: boolean } {
    let verbose = false;
    for (const argument of args) {
      if (argument === "--verbose") verbose = true;
      else if (argument === "-h" || argument === "--help") {
        this.write("Usage: muximo doctor [--verbose]\n");
        return { verbose: false };
      } else throw new MuximoCommandError(`unknown doctor option: ${argument}`);
    }
    return { verbose };
  }

  private async runSession(backend: AgentBackend, options: RunOptions): Promise<number> {
    const logger = this.currentLogger.child({ command: "run", backend });
    const sessionStartedAt = Date.now();
    logger.debug("session.starting", {
      useWorktree: options.useWorktree,
      backendArgumentCount: options.backendArgs.length,
    });
    const backendBinary = resolveBackendCommand(backend, this.env);
    logger.debug("backend.resolved", {
      executable: basename(backendBinary),
    });
    if (hasOption("--help", options.backendArgs) || hasOption("-h", options.backendArgs)) {
      const helpArgs =
        backend === "codex" &&
        options.codexProfile &&
        !hasOption("--profile", options.backendArgs) &&
        !hasOption("-p", options.backendArgs)
          ? ["--profile", options.codexProfile, ...options.backendArgs]
          : options.backendArgs;
      logger.debug("backend.help_started", { argumentCount: helpArgs.length });
      const status = await runAttachedProcess(backendBinary, helpArgs, this.cwd, this.env, logger, "backend_help");
      logger.debug("backend.help_finished", { status, durationMs: Date.now() - sessionStartedAt });
      return status;
    }

    this.ensureDatabase();
    await ensureCodexRemoteControl(
      backend,
      options.backendArgs,
      backendBinary,
      this.defaultCodexRemote,
      this.env,
      logger,
    );
    const workspace = await this.resolveWorkspace();
    logger.debug("workspace.resolved", {
      workspaceId: workspace.id,
      isGit: workspace.isGit,
    });
    const setupHook = options.setupHookExplicit
      ? options.setupHook
        ? this.resolveHookPath(options.setupHook, workspace.rootPath)
        : undefined
      : options.useWorktree
        ? this.resolveStoredHook(workspace.setupScriptPath)
        : undefined;
    const cleanupHook = options.cleanupHookExplicit
      ? options.cleanupHook
        ? this.resolveHookPath(options.cleanupHook, workspace.rootPath)
        : undefined
      : options.useWorktree
        ? this.resolveStoredHook(workspace.cleanupScriptPath)
        : undefined;

    const name = normalizeSessionName(options.name ?? (await this.generateName(workspace.id, backend)));
    const existing = (await this.sessions.list(workspace.id)).find((session) => {
      try {
        return normalizeAgentSessionName(session.name) === name;
      } catch {
        return false;
      }
    });
    if (existing) throw new MuximoCommandError(`session name already exists in this workspace: ${existing.name}`);

    const worktree = options.useWorktree ? this.createWorktree(workspace, name, options.worktreeRoot) : emptyWorktree();
    const now = timestamp();
    const claudeBackendSessionId =
      backend === "claude" ? (optionValue("--session-id", options.backendArgs) ?? randomUUID()) : undefined;
    const codexRemote =
      backend === "codex" ? codexRemoteEndpoint(options.backendArgs, this.defaultCodexRemote) : undefined;
    const session = AgentSession.create({
      id: AgentSessionId.create(randomUUID()),
      name,
      backend,
      status: "starting",
      workspaceId: workspace.id,
      workspaceRoot: workspace.rootPath,
      workspaceName: workspace.name,
      ...worktree,
      useWorktree: options.useWorktree,
      ...(setupHook === undefined ? {} : { setupHook }),
      ...(cleanupHook === undefined ? {} : { cleanupHook }),
      // A Claude session ID is generated locally for the launch command, but
      // is persisted only after the backend process has actually spawned.
      // This keeps setup-stage crashes from becoming falsely resumable.
      ...(backend === "codex" && options.codexProfile !== undefined ? { codexProfile: options.codexProfile } : {}),
      ...(codexRemote ? { codexRemote } : {}),
      setupRan: false,
      resuming: false,
      executionId: randomUUID(),
      executionPid: process.pid,
      executionStartedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await this.sessions.insert(session);
    this.audit("agent_session.created", session.id, { name, backend, workspace: workspace.rootPath });
    const sessionLogger = logger.child({
      sessionId: session.id,
      sessionName: session.name,
      workspaceId: session.workspaceId,
    });
    sessionLogger.debug("session.created", {
      useWorktree: session.useWorktree,
      worktreePath: session.worktreePath ?? null,
    });

    let current = updateSession(session, { status: "setup" });
    await this.sessions.update(current);
    sessionLogger.debug("session.status_changed", { status: current.status });
    if (!(await this.copyWorktreeFiles(current, workspace.worktreeCopyPatterns))) {
      current = updateSession(current, { status: "setup_failed" });
      await this.sessions.update(current);
      sessionLogger.debug("session.setup_failed", { stage: "worktree_copy" });
      throw new MuximoCommandError(`worktree file copy failed; mapping retained as '${name}'`);
    }
    if (!(await this.runHook(current, "setup"))) {
      current = updateSession(current, { status: "setup_failed" });
      await this.sessions.update(current);
      sessionLogger.debug("session.setup_failed", { stage: "setup_hook" });
      throw new MuximoCommandError(`setup hook failed; mapping retained as '${name}'`);
    }
    current = updateSession(current, { setupRan: Boolean(current.setupHook) });
    if (current.useWorktree)
      current = updateSession(current, { baselineStatus: this.gitStatus(current.worktreePath!) });
    current = updateSession(current, { status: "ready" });
    await this.sessions.update(current);
    sessionLogger.debug("session.status_changed", { status: current.status });

    const runDir = current.worktreePath ?? current.workspaceRoot;
    const codexBaseline = await this.captureCodexSessionBaseline(current);
    if (!codexBaseline) {
      current = updateSession(current, { status: "setup_failed" });
      await this.sessions.update(current);
      sessionLogger.debug("session.setup_failed", { stage: "codex_baseline" });
      throw new MuximoCommandError("Codex rollout baseline capture failed; mapping retained");
    }
    sessionLogger.debug("session.baseline_captured", { backend: current.backend });
    const startedAt = Math.floor(Date.now() / 1000);
    current = updateSession(current, {
      status: "running",
      ...(claudeBackendSessionId === undefined ? {} : { backendSessionId: claudeBackendSessionId }),
    });
    // Keep the generated Claude ID out of durable state until runBackend has
    // observed a successful child spawn. Codex remains unbound until discovery.
    await this.sessions.update(updateSession(current, { backendSessionId: clearPatch }));
    sessionLogger.debug("session.status_changed", { status: current.status });
    let launch: BackendLaunch;
    try {
      launch = await this.createBackendLaunch(current, options.backendArgs, backendBinary, runDir, sessionLogger);
    } catch (error) {
      sessionLogger.debug("session.launch_failed", {
        ...errorFields(error),
      });
      current = updateSession(current, { status: "exited", lastExitStatus: 1 });
      await this.sessions.update(current).catch(() => undefined);
      throw error;
    }
    if (launch.backendSessionId) {
      sessionLogger.debug("backend.session_prepared", { backendSessionIdPresent: true });
    }
    await this.adoptSessionPane(current);
    this.markCurrentPane({ kind: "agent", agentId: backend, name: current.name });
    const previousPaneCwd = this.adoptTmuxPaneCwd(runDir);
    let result: ProcessResult;
    try {
      await this.publishAgentObservation(current, "running");
      result = await this.runBackend(current, launch.command, runDir, startedAt, {
        monitor: launch.monitor,
        backendSessionId: launch.backendSessionId,
      });
      await this.publishAgentObservation(
        current,
        result.interrupted ? "stopped" : result.code === 0 ? "completed" : "failed",
      );
      await this.abortRemoteSessionIfInterrupted(current, launch.abortSession, result);
    } finally {
      await this.releaseSessionPane(current);
      this.restoreCurrentPaneMetadata();
      this.restoreTmuxPaneCwd(previousPaneCwd);
    }
    const status = await this.finalizeSession(current, result, startedAt, runDir, codexBaseline);
    sessionLogger.debug("session.finished", { status, durationMs: Date.now() - startedAt * 1000 });
    return status;
  }

  private async resumeSession(options: ResumeOptions): Promise<number> {
    if (!options.reference) return 0;
    let session = await this.locateSession(options.reference, options.global);
    const logger = this.currentLogger.child({
      command: "resume",
      sessionId: session.id,
      sessionName: session.name,
      workspaceId: session.workspaceId,
      backend: session.backend,
    });
    const sessionStartedAt = Date.now();
    logger.debug("session.resume_starting", {
      global: options.global,
      backendArgumentCount: options.backendArgs.length,
    });
    if (session.status === "setup_failed")
      throw new MuximoCommandError(`session '${session.name}' has a failed setup; clean it up before retrying`);
    if (session.status === "starting" || session.status === "setup" || session.status === "ready") {
      throw new MuximoCommandError(
        `session '${session.name}' has not started its backend; rerun it instead of resuming`,
      );
    }
    const runDir = session.worktreePath ?? session.workspaceRoot;
    if (!existsSync(runDir)) throw new MuximoCommandError(`session working directory is missing: ${runDir}`);
    if (session.useWorktree && !this.worktreeIsRegistered(session))
      throw new MuximoCommandError(`managed worktree is no longer registered: ${session.worktreePath}`);
    if (!session.backendSessionId && session.backend === "codex") {
      session = await this.repairCodexSessionId(session, runDir, "resume");
    }
    if (!session.backendSessionId)
      throw new MuximoCommandError(`session '${session.name}' has no backend session ID; it cannot be resumed`);
    const backendBinary = resolveBackendCommand(session.backend, this.env);
    logger.debug("backend.resolved", { executable: basename(backendBinary) });
    await ensureCodexRemoteControl(
      session.backend,
      options.backendArgs,
      backendBinary,
      session.codexRemote ?? this.defaultCodexRemote,
      this.env,
      logger,
    );
    if (session.executionPid !== undefined && isProcessAlive(session.executionPid)) {
      throw new MuximoCommandError(`session '${session.name}' is already running (pid ${session.executionPid})`);
    }
    const executionId = randomUUID();
    const executionStartedAt = timestamp();
    const claimed = await this.sessions.claimExecution(
      session.id,
      session.executionPid ?? null,
      executionId,
      process.pid,
      executionStartedAt,
    );
    if (!claimed) throw new MuximoCommandError(`session '${session.name}' is already being resumed`);
    const current = updateSession(session, {
      status: "resuming",
      resuming: true,
      executionId,
      executionPid: process.pid,
      executionStartedAt,
    });
    await this.sessions.update(current);
    let launch: BackendLaunch;
    try {
      launch = await this.createBackendLaunch(current, options.backendArgs, backendBinary, runDir, logger, true);
    } catch (error) {
      logger.debug("session.launch_failed", { ...errorFields(error) });
      await this.sessions
        .update(updateSession(current, { status: "exited", lastExitStatus: 1 }))
        .catch(() => undefined);
      throw error;
    }
    logger.debug("backend.command_ready", { argumentCount: launch.command.length, resume: true });
    await this.adoptSessionPane(current);
    const startedAt = Math.floor(Date.now() / 1000);
    this.markCurrentPane({ kind: "agent", agentId: session.backend, name: current.name });
    const previousPaneCwd = this.adoptTmuxPaneCwd(runDir);
    let result: ProcessResult;
    try {
      await this.publishAgentObservation(current, "running");
      result = await this.runBackend(current, launch.command, runDir, startedAt, {
        monitor: launch.monitor,
        backendSessionId: launch.backendSessionId,
      });
      await this.publishAgentObservation(
        current,
        result.interrupted ? "stopped" : result.code === 0 ? "completed" : "failed",
      );
      await this.abortRemoteSessionIfInterrupted(current, launch.abortSession, result);
    } finally {
      await this.releaseSessionPane(current);
      this.restoreCurrentPaneMetadata();
      this.restoreTmuxPaneCwd(previousPaneCwd);
    }
    const status = await this.finalizeSession(current, result, startedAt, runDir, true);
    logger.debug("session.resume_finished", { status, durationMs: Date.now() - sessionStartedAt });
    return status;
  }

  private async adoptSessionPane(session: AgentSessionRecord): Promise<void> {
    const tmuxPaneId = currentTmuxPane(this.env);
    if (!tmuxPaneId || !session.executionId) return;
    const input = { agentSessionId: session.id, tmuxPaneId, executionId: session.executionId };
    try {
      const control = await MuximodPairingControlAdapter.connect(defaultControlSocket(this.env, this.databaseFile));
      try {
        await control.adoptAgentSession(input);
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) {
        setFallbackSessionMetadata(this.env, input);
        return;
      }
      this.warn(
        `muximod could not adopt pane ${tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async releaseSessionPane(session: AgentSessionRecord): Promise<void> {
    const tmuxPaneId = currentTmuxPane(this.env);
    if (!tmuxPaneId || !session.executionId) return;
    const input = { agentSessionId: session.id, tmuxPaneId, executionId: session.executionId };
    try {
      const control = await MuximodPairingControlAdapter.connect(defaultControlSocket(this.env, this.databaseFile));
      try {
        await control.releaseAgentSession(input);
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) {
        if (clearFallbackSessionMetadata(this.env, input)) {
          try {
            this.tmux.resetAgentPaneMetadata(tmuxPaneId);
          } catch {
            // A disappearing tmux pane is already on its way out of the projection.
          }
        }
        return;
      }
      this.warn(
        `muximod could not release pane ${tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async publishAgentObservation(
    session: AgentSessionRecord,
    state: PaneState,
    recentOutput?: string,
  ): Promise<void> {
    const tmuxPaneId = currentTmuxPane(this.env);
    if (!tmuxPaneId || !session.executionId) return;
    try {
      const control = await MuximodPairingControlAdapter.connect(defaultControlSocket(this.env, this.databaseFile));
      try {
        await control.observeAgentSession({
          agentSessionId: session.id,
          tmuxPaneId,
          executionId: session.executionId,
          state,
          ...(recentOutput ? { recentOutput } : {}),
        });
      } finally {
        control.close();
      }
    } catch (error) {
      if (isControlSocketUnavailable(error)) return;
      this.currentLogger.debug("agent.observation_publish_failed", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async listSessions(options: SessionListOptions): Promise<number> {
    return executeListSessions(options, {
      env: this.env,
      logger: this.currentLogger,
      write: (value) => this.write(value),
      info: (value) => this.info(value),
      resolveWorkspace: async () => await this.resolveWorkspace(),
      sessions: this.sessions,
    });
  }
  private async confirmCleanup(session: AgentSessionRecord, dirty: boolean): Promise<boolean> {
    return confirmCleanupFn({ env: this.env }, session, dirty);
  }

  private async resolveWorkspace(): Promise<WorkspaceContext> {
    const startedAt = Date.now();
    this.currentLogger.debug("workspace.resolve_started", { cwd: this.cwd });
    const selectedWorkspaceId = this.env.MUXIMOD_WORKSPACE_ID?.trim();
    if (selectedWorkspaceId) {
      const selected = await this.workspaces.findById(WorkspaceId.create(selectedWorkspaceId));
      if (selected) {
        this.currentLogger.debug("workspace.resolve_finished", {
          workspaceId: selected.id,
          isGit: selected.isGit,
          registered: true,
          selected: true,
          durationMs: Date.now() - startedAt,
        });
        return selected;
      }
    }
    const gitRoot = gitWorkspaceRoot(this.cwd);
    const root = gitRoot ?? this.cwd;
    const id = workspaceIdForPath(root);
    const existing = (await this.workspaces.findById(id)) ?? (await this.findRegisteredWorkspaceForCwd(root));
    if (existing) {
      this.currentLogger.debug("workspace.resolve_finished", {
        workspaceId: existing.id,
        isGit: existing.isGit,
        registered: true,
        durationMs: Date.now() - startedAt,
      });
      return existing;
    }
    const context: WorkspaceContext = {
      id,
      rootPath: root,
      name: basename(root),
      isGit: Boolean(gitRoot),
      worktreeCopyPatterns: [],
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    this.currentLogger.debug("workspace.resolve_finished", {
      workspaceId: context.id,
      isGit: context.isGit,
      registered: false,
      durationMs: Date.now() - startedAt,
    });
    return context;
  }

  private async resolveWorktreeShellCwd(environment: NodeJS.ProcessEnv): Promise<string> {
    const sessionName = environment.MUXIMOD_WORKTREE_SESSION_NAME?.trim();
    if (!sessionName) return this.cwd;

    try {
      this.ensureDatabase();
      const workspace = await this.resolveWorkspace();
      const session = await this.sessions.findByName(workspace.id, sessionName);
      if (session?.useWorktree && session.worktreePath && existsSync(session.worktreePath)) return session.worktreePath;
    } catch {
      // A shell should remain usable even if session metadata is unavailable.
    }
    return this.cwd;
  }

  private adoptTmuxPaneCwd(directory: string): string | undefined {
    if (!this.env.TMUX_PANE) return undefined;
    const previousCwd = process.cwd();
    if (previousCwd !== directory) process.chdir(directory);
    return previousCwd;
  }

  private restoreTmuxPaneCwd(previousCwd: string | undefined): void {
    if (!previousCwd || process.cwd() === previousCwd) return;
    process.chdir(previousCwd);
  }

  private async findRegisteredWorkspaceForCwd(gitRoot: string): Promise<WorkspaceRecord | undefined> {
    if (this.cwd === gitRoot) return undefined;
    const candidates = (await this.workspaces.list())
      .filter((workspace) => workspace.rootPath !== gitRoot)
      .filter((workspace) => isPathWithin(gitRoot, workspace.rootPath) && isPathWithin(workspace.rootPath, this.cwd))
      .sort((left, right) => right.rootPath.length - left.rootPath.length);
    return candidates[0];
  }

  private resolveHookPath(value: string, workspaceRoot: string): string {
    const path = realpathSafe(isAbsolute(value) ? value : join(workspaceRoot, value));
    if (!existsSync(path)) throw new MuximoCommandError(`workspace hook does not exist: ${value}`);
    accessSync(path, constants.X_OK);
    if (!statSync(path).isFile()) throw new MuximoCommandError(`workspace hook is not a file: ${path}`);
    return path;
  }

  private resolveStoredHook(path: string | undefined): string | undefined {
    return path ? this.resolveHookPath(path, this.cwd) : undefined;
  }

  private async generateName(workspaceId: WorkspaceId, backend: AgentBackend): Promise<string> {
    const prefix = `${backend}-${localTimestamp()}`;
    let candidate = prefix;
    let suffix = 0;
    while (await this.sessions.findByName(workspaceId, candidate)) {
      suffix += 1;
      candidate = `${prefix}-${suffix}`;
    }
    return candidate;
  }

  private createWorktree(
    workspace: WorkspaceContext,
    name: string,
    override?: string,
  ): Pick<AgentSessionRecord, "worktreeRoot" | "worktreePath" | "branch" | "baseCommit"> {
    if (!workspace.isGit)
      throw new MuximoCommandError("a managed worktree requires a git workspace; use --no-worktree here");
    const defaultRoot =
      this.env.MUXIMO_WORKTREE_ROOT ?? join(dirname(workspace.rootPath), `${workspace.name}.worktrees`);
    const configuredRoot =
      override ?? (this.env.MUXIMO_WORKTREE_ID ? join(defaultRoot, this.env.MUXIMO_WORKTREE_ID) : defaultRoot);
    const worktreeRoot = realpathAfterMkdir(resolveFromRoot(configuredRoot, workspace.rootPath));
    const worktreePath = join(worktreeRoot, name);
    let branch = this.worktreeBranch(name);
    const baseCommit = gitRequired(workspace.rootPath, ["rev-parse", "HEAD"], "cannot determine the workspace HEAD");
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) {
      branch = `muximo/${this.env.MUXIMO_WORKTREE_ID ?? workspace.id}/${name}`;
    }
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0)
      throw new MuximoCommandError(
        `muximo branch already exists; choose another name or remove it manually: ${branch}`,
      );
    if (existsSync(worktreePath)) throw new MuximoCommandError(`worktree path already exists: ${worktreePath}`);
    this.currentLogger.debug("worktree.create_started", {
      workspaceId: workspace.id,
      worktreePath,
      branch,
    });
    this.info(`creating worktree '${worktreePath}'`);
    gitRequired(
      workspace.rootPath,
      ["worktree", "add", "-b", branch, "--", worktreePath, baseCommit],
      "git worktree creation failed",
    );
    this.currentLogger.debug("worktree.created", { workspaceId: workspace.id, worktreePath, branch });
    return { worktreeRoot, worktreePath, branch, baseCommit };
  }

  private worktreeBranch(name: string): string {
    const worktreeId = this.env.MUXIMO_WORKTREE_ID;
    return worktreeId ? `muximo/${worktreeId}/${name}` : `muximo/${name}`;
  }

  private async copyWorktreeFiles(
    target: { workspaceRoot: string; worktreePath?: string | null },
    configuredPatterns: readonly string[],
  ): Promise<boolean> {
    if (!target.worktreePath || !configuredPatterns.length) {
      return true;
    }

    const patterns = normalizeWorktreeCopyPatterns(configuredPatterns);
    if (patterns.some((pattern) => !isValidWorktreeCopyPattern(pattern))) {
      this.warn("workspace contains an invalid worktree copy pattern");
      return false;
    }

    const sourceFiles = listUnmanagedFiles(target.workspaceRoot);
    const matchedFiles = new Set<string>();
    for (const pattern of patterns) {
      const matches = sourceFiles.filter((file) => matchesWorktreeCopyPattern(pattern, file));
      if (!matches.length) this.warn(`worktree copy pattern matched no unmanaged files: ${pattern}`);
      for (const file of matches) matchedFiles.add(file);
    }

    for (const relativePath of [...matchedFiles].sort()) {
      const sourcePath = resolve(target.workspaceRoot, relativePath);
      const targetPath = resolve(target.worktreePath, relativePath);
      if (!isPathWithin(target.workspaceRoot, sourcePath) || !isPathWithin(target.worktreePath, targetPath)) {
        this.warn(`refusing to copy a path outside the worktree: ${relativePath}`);
        return false;
      }
      try {
        const sourceStat = lstatSync(sourcePath);
        if (!sourceStat.isFile()) {
          this.warn(`refusing to copy a non-regular file: ${relativePath}`);
          return false;
        }
        if (!isPathWithin(target.workspaceRoot, realpathSafe(sourcePath))) {
          this.warn(`refusing to copy a source path outside the workspace: ${relativePath}`);
          return false;
        }
        mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
        if (!isPathWithin(target.worktreePath, realpathSafe(dirname(targetPath)))) {
          this.warn(`refusing to copy through a worktree symlink: ${relativePath}`);
          return false;
        }
        copyFileSync(sourcePath, targetPath);
        chmodSync(targetPath, sourceStat.mode & 0o777);
      } catch (error) {
        this.warn(
          `could not copy unmanaged file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }
    return true;
  }

  private async runHook(session: AgentSessionRecord, kind: "setup" | "cleanup"): Promise<boolean> {
    const hook = kind === "setup" ? session.setupHook : session.cleanupHook;
    if (!hook) return true;
    const success = await this.runHookCore({
      hook,
      kind,
      runDir: session.worktreePath ?? session.workspaceRoot,
      name: session.name,
      backend: session.backend,
      workspaceRoot: session.workspaceRoot,
      worktreePath: session.worktreePath ?? "",
      backendSessionId: session.backendSessionId ?? "",
      stateId: session.id,
      resuming: session.resuming,
      setupOutputFile: session.setupOutputFile ?? "",
    });
    const finalOutput = this.hookOutputFile(session.id, kind);
    const next = updateSession(
      session,
      kind === "setup" ? { setupOutputFile: finalOutput } : { cleanupOutputFile: finalOutput },
    );
    Object.assign(session, next);
    await this.sessions.update(next);
    return success;
  }

  private async runShellHook(ctx: WorktreeShellContext, kind: "setup" | "cleanup"): Promise<boolean> {
    const hook = kind === "setup" ? ctx.setupHook : ctx.cleanupHook;
    if (!hook || !ctx.worktreePath) return true;
    return this.runHookCore({
      hook,
      kind,
      runDir: ctx.worktreePath,
      name: ctx.name,
      backend: "shell",
      workspaceRoot: ctx.workspaceRoot,
      worktreePath: ctx.worktreePath,
      backendSessionId: "",
      stateId: `shell-${ctx.name}`,
      resuming: false,
      setupOutputFile: "",
    });
  }

  /**
   * Remove the worktree owned by a `muximo shell --worktree` pane after the
   * shell exits. Runs the cleanup hook first, then removes the git worktree.
   * A dirty worktree is kept and reported so uncommitted shell work is never
   * silently destroyed.
   */
  private async disposeWorktreeShell(ctx: WorktreeShellContext): Promise<void> {
    const logger = this.currentLogger.child({ sessionName: ctx.name, hook: "cleanup" });
    const startedAt = Date.now();
    if (await this.runShellHook(ctx, "cleanup")) {
      logger.debug("hook.cleanup_finished", { durationMs: Date.now() - startedAt });
    }
    if (!ctx.worktreePath || !existsSync(ctx.worktreePath)) return;
    if (!this.worktreeIsRegisteredAt(ctx.workspaceRoot, ctx.worktreePath)) {
      this.warn(`managed path is not registered as a git worktree; refusing to delete it: ${ctx.worktreePath}`);
      return;
    }
    const dirty = this.gitStatus(ctx.worktreePath) !== "";
    if (dirty) {
      this.warn(
        `shell worktree has uncommitted changes; keeping it: ${ctx.worktreePath} (branch ${ctx.branch ?? "unknown"})`,
      );
      return;
    }
    try {
      gitRequired(ctx.workspaceRoot, ["worktree", "remove", "--", ctx.worktreePath], "git worktree removal failed");
    } catch (_error) {
      this.warn(`git worktree removal failed; keeping worktree at '${ctx.worktreePath}'`);
      return;
    }
    try {
      if (ctx.worktreeRoot) unlinkEmptyDirectory(ctx.worktreeRoot);
    } catch {
      // A root containing another managed worktree is expected to remain.
    }
    if (ctx.branch) {
      const head = gitOutputOrEmpty(ctx.workspaceRoot, ["rev-parse", "--verify", ctx.branch]);
      if (head && head === ctx.baseCommit) gitStatusCode(ctx.workspaceRoot, ["branch", "-d", ctx.branch]);
      else if (head) this.info(`keeping committed shell branch '${ctx.branch}'`);
    }
  }

  private worktreeIsRegisteredAt(workspaceRoot: string, worktreePath: string): boolean {
    return gitOutputOrEmpty(workspaceRoot, ["worktree", "list", "--porcelain"])
      .split("\n")
      .some((line) => line === `worktree ${worktreePath}`);
  }

  private async runHookCore(input: {
    hook: string;
    kind: "setup" | "cleanup";
    runDir: string;
    name: string;
    backend: string;
    workspaceRoot: string;
    worktreePath: string;
    backendSessionId: string;
    stateId: string;
    resuming: boolean;
    setupOutputFile: string;
  }): Promise<boolean> {
    const { hook, kind, runDir } = input;
    if (!existsSync(runDir)) {
      this.warn(`cannot run ${kind} hook; directory does not exist: ${runDir}`);
      return false;
    }
    const outputFile = `${this.hookOutputFile(input.stateId, kind)}.${randomUUID()}`;
    const logger = this.currentLogger.child({
      sessionId: input.stateId,
      sessionName: input.name,
      hook: kind,
    });
    const startedAt = Date.now();
    logger.debug("hook.started", { script: basename(hook), cwd: runDir });
    this.info(`running workspace hook '${hook}' (${kind})`);
    const args = [
      "--name",
      input.name,
      "--backend",
      input.backend,
      "--workspace",
      input.workspaceRoot,
      "--worktree",
      input.worktreePath,
      "--session-id",
      input.backendSessionId,
      "--state-id",
      input.stateId,
      "--resuming",
      input.resuming ? "1" : "0",
    ];
    if (kind === "cleanup" && input.setupOutputFile) args.push("--setup-output-file", input.setupOutputFile);
    const child = spawn(hook, args, {
      cwd: runDir,
      env: {
        ...this.env,
        MUXIMO_NAME: input.name,
        MUXIMO_BACKEND: input.backend,
        MUXIMO_WORKSPACE: input.workspaceRoot,
        MUXIMO_WORKTREE: input.worktreePath,
        MUXIMO_SESSION_ID: input.backendSessionId,
        MUXIMO_STATE_ID: input.stateId,
        MUXIMO_HOOK_KIND: kind,
        MUXIMO_HOOK_SCRIPT: hook,
        MUXIMO_SETUP_OUTPUT_FILE: input.setupOutputFile,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let spawnError: unknown;
    const output = createWriteStream(outputFile, { mode: 0o600 });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.io.out.write(chunk);
      output.write(chunk);
    });
    const exitCode = await new Promise<number>((resolvePromise) => {
      child.once("error", (error) => {
        spawnError = error;
        resolvePromise(127);
      });
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    await new Promise<void>((resolvePromise, reject) => {
      output.once("finish", resolvePromise);
      output.once("error", reject);
      output.end();
    });
    const finalOutput = this.hookOutputFile(input.stateId, kind);
    renameSync(outputFile, finalOutput);
    logger.debug("hook.finished", {
      pid: child.pid,
      exitCode,
      success: exitCode === 0,
      durationMs: Date.now() - startedAt,
      ...(spawnError ? errorFields(spawnError) : {}),
    });
    return exitCode === 0;
  }

  private hookOutputFile(stateId: string, kind: "setup" | "cleanup"): string {
    const dir = join(this.hookOutputRoot, stateId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `${kind}.log`);
  }

  private async runBackend(
    session: AgentSessionRecord,
    command: string[],
    runDir: string,
    startedAt: number,
    options: { monitor?: AgentMonitor; backendSessionId?: string | null } = {},
  ): Promise<ProcessResult> {
    const logger = this.currentLogger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
    });
    const processStartedAt = Date.now();
    logger.debug("subprocess.starting", {
      kind: "backend",
      executable: basename(command[0] ?? "unknown"),
      cwd: runDir,
      argumentCount: command.length - 1,
    });
    this.setTerminalTitle(session.name);
    const nameWatcher =
      session.backend === "codex" && session.backendSessionId === undefined && session.codexRemote
        ? this.watchCodexSessionName(session, startedAt, runDir)
        : undefined;
    const monitor = options.monitor ?? this.createAgentMonitor(session, runDir, startedAt);
    const preparedBackendSessionId = options.backendSessionId;
    let monitorStarted = false;
    let result: ProcessResult;
    try {
      if (monitor) {
        try {
          await monitor.start((observation) => this.publishPluginObservation(session, observation));
          monitorStarted = true;
        } catch (error) {
          logger.debug("agent.monitor_start_failed", errorFields(error));
        }
      }
      result = await spawnAttached(
        command[0]!,
        command.slice(1),
        runDir,
        {
          ...this.env,
          MUXIMOD_AGENT_SESSION_ID: session.id,
          MUXIMOD_AGENT_ID: session.backend,
        },
        {
          onStarted: async (pid) => {
            logger.debug("subprocess.started", {
              kind: "backend",
              executable: basename(command[0] ?? "unknown"),
              cwd: runDir,
              pid,
            });
            if (session.backend === "claude" && session.backendSessionId) {
              try {
                await this.sessions.update(session);
              } catch (error) {
                this.warn(
                  `Claude session launch was not persisted for resume: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
              return;
            }
            if (session.backend === "opencode" && preparedBackendSessionId) {
              try {
                await this.sessions.update(updateSession(session, { backendSessionId: preparedBackendSessionId }));
              } catch (error) {
                this.warn(
                  `OpenCode session launch was not persisted for resume: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
          },
          onError: (error) =>
            logger.debug("subprocess.spawn_failed", {
              kind: "backend",
              executable: basename(command[0] ?? "unknown"),
              ...errorFields(error),
            }),
        },
      );
    } finally {
      if (monitorStarted && monitor) {
        try {
          await monitor.stop();
        } catch (error) {
          logger.debug("agent.monitor_stop_failed", errorFields(error));
        }
      }
      if (nameWatcher) {
        try {
          await nameWatcher.stop();
        } catch (error) {
          logger.debug("codex.session_name_watch_failed", { ...errorFields(error) });
        }
      }
      this.restoreTerminalTitle();
    }
    logger.debug("subprocess.finished", {
      kind: "backend",
      pid: result.pid,
      exitCode: result.code,
      signal: result.signal,
      interrupted: result.interrupted,
      durationMs: Date.now() - processStartedAt,
    });
    return result;
  }

  private createAgentMonitor(session: AgentSessionRecord, runDir: string, startedAt: number): AgentMonitor | undefined {
    const plugin = this.agentPlugins.get(session.backend);
    if (!plugin?.createMonitor) return undefined;
    return plugin.createMonitor({
      sessionId: session.id,
      executionId: session.executionId ?? "",
      cwd: runDir,
      startedAt: new Date(startedAt * 1_000).toISOString(),
      backendSessionId: session.backendSessionId ?? null,
      environment: this.env,
    });
  }

  private async createBackendLaunch(
    session: AgentSessionRecord,
    backendArgs: string[],
    backendBinary: string,
    runDir: string,
    logger: Logger,
    resume = false,
  ): Promise<BackendLaunch> {
    const plugin = this.agentPlugins.get(session.backend);
    if (plugin?.prepareLaunch && session.backend === "opencode") {
      const plan = await plugin.prepareLaunch({
        cwd: runDir,
        args: backendArgs,
        environment: stringEnvironment(this.env),
        name: session.name,
        monitorContext: {
          sessionId: session.id,
          executionId: session.executionId ?? "",
          cwd: runDir,
          startedAt: new Date().toISOString(),
          backendSessionId: session.backendSessionId ?? null,
          environment: this.env,
        },
        resumeSessionId: session.backendSessionId ?? null,
      });
      logger.debug("backend.command_ready", { argumentCount: plan.primary.args.length, prepared: true });
      return {
        command: [plan.primary.command, ...plan.primary.args],
        monitor: plan.monitor,
        backendSessionId: plan.backendSessionId ?? null,
        abortSession: plan.monitor?.execute
          ? async () => {
              await plan.monitor?.execute?.({ ...openCodeMonitorActions.abort });
            }
          : undefined,
      };
    }
    const command = resume
      ? buildResumeCommand(session, backendArgs, this.defaultCodexRemote, backendBinary)
      : buildRunCommand(session, backendArgs, this.defaultCodexRemote, backendBinary);
    logger.debug("backend.command_ready", { argumentCount: command.length, resume });
    return { command, monitor: undefined, backendSessionId: undefined };
  }

  private async abortRemoteSessionIfInterrupted(
    session: AgentSessionRecord,
    abortSession: (() => Promise<void>) | undefined,
    result: ProcessResult,
  ): Promise<void> {
    if (!result.interrupted || !abortSession) return;
    try {
      await abortSession();
    } catch (error) {
      this.warn(
        `OpenCode session abort failed for '${session.name}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async publishPluginObservation(session: AgentSessionRecord, observation: AgentObservation): Promise<void> {
    if (observation.type !== "state_changed") return;
    await this.publishAgentObservation(session, observation.state, observation.recentOutput);
  }

  private async finalizeSession(
    session: AgentSessionRecord,
    result: ProcessResult,
    startedAt: number,
    runDir: string,
    codexBaseline: boolean,
  ): Promise<number> {
    const logger = this.currentLogger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
    });
    logger.debug("session.finalizing", {
      exitCode: result.code,
      signal: result.signal,
      interrupted: result.interrupted,
    });
    if (session.backend === "codex" && !session.backendSessionId && codexBaseline) {
      const discovery = await this.discoverCodexSessionId(startedAt, runDir, session.id);
      if (discovery.selectedId) {
        session = updateSession(session, { backendSessionId: discovery.selectedId });
        logger.debug("codex.session_id_discovered", { backendSessionIdPresent: true });
        // The explicit helper has a bounded child-process timeout. The native
        // app-server transport may wait on a socket, so keep it off the
        // confirmation path; the live watcher handles that best-effort.
        if (session.codexRemote && this.env.MUXIMO_CODEX_NAME_BIN) await this.manageRemoteThread(session, "name");
      } else {
        const persisted = await this.sessions.findById(session.id);
        if (persisted?.backendSessionId) session = persisted;
        else this.reportCodexDiscoveryFailure(session, runDir, "finalize", discovery);
      }
    }
    session = updateSession(session, {
      lastExitStatus: result.code,
      executionId: clearPatch,
      executionPid: clearPatch,
      executionStartedAt: clearPatch,
    });
    logger.debug("session.backend_finished", {
      exitCode: result.code,
      interrupted: result.interrupted,
    });
    if (result.interrupted || result.code === 130 || result.code === 143) {
      session = updateSession(session, { status: "interrupted" });
      await this.sessions.update(session);
      logger.debug("session.interrupted", { status: session.status });
      this.info(`session '${session.name}' kept for resume after interruption`);
      return result.code;
    }
    session = updateSession(session, { status: "exited" });
    await this.sessions.update(session);
    if (!session.useWorktree) {
      logger.debug("session.finished", {
        status: session.status,
        cleanup: "retained",
        durationMs: Date.now() - startedAt * 1000,
      });
      this.info(
        `session '${session.name}' mapping retained; use 'muximo resume ${session.name}' or 'muximo cleanup ${session.name}'`,
      );
      return result.code;
    }
    const dirty = this.worktreeHasAgentChanges(session);
    logger.debug("session.cleanup_decision", { dirty });
    if (!(await this.confirmCleanup(session, dirty))) {
      logger.debug("session.cleanup_declined", { dirty });
      this.info(`cleanup declined; session '${session.name}' kept for resume`);
      return result.code;
    }
    if (!(await this.removeSessionRecord(session, dirty))) {
      logger.debug("session.cleanup_failed", { dirty });
      this.info(`session '${session.name}' retained because cleanup did not complete`);
      return result.code === 0 ? 1 : result.code;
    }
    logger.debug("session.finished", {
      status: session.status,
      cleanup: "completed",
      durationMs: Date.now() - startedAt * 1000,
    });
    this.info(`session '${session.name}' cleaned up`);
    return result.code;
  }

  private async removeSessionRecord(session: AgentSessionRecord, force: boolean): Promise<boolean> {
    const logger = this.currentLogger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
    });
    const startedAt = Date.now();
    logger.debug("session.cleanup_started", { force, useWorktree: session.useWorktree });
    if (
      session.useWorktree &&
      session.worktreePath &&
      existsSync(session.worktreePath) &&
      !this.worktreeIsRegistered(session)
    ) {
      logger.debug("session.cleanup_failed", { stage: "worktree_registration" });
      this.warn(`managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`);
      return false;
    }
    if (session.backend === "codex" && session.codexRemote) {
      if (!(await this.manageRemoteThread(session, "archive"))) {
        logger.debug("session.cleanup_failed", { stage: "codex_archive" });
        return false;
      }
    }
    if (!(await this.runHook(session, "cleanup"))) {
      if (session.backend === "codex" && session.codexRemote) await this.manageRemoteThread(session, "unarchive");
      logger.debug("session.cleanup_failed", { stage: "cleanup_hook" });
      this.warn("cleanup hook failed; retaining session mapping");
      return false;
    }
    if (session.useWorktree && session.worktreePath && existsSync(session.worktreePath)) {
      try {
        gitRequired(
          session.workspaceRoot,
          ["worktree", "remove", ...(force ? ["--force"] : []), "--", session.worktreePath],
          "git worktree removal failed",
        );
      } catch (error) {
        if (session.backend === "codex" && session.codexRemote) await this.manageRemoteThread(session, "unarchive");
        logger.debug("session.cleanup_failed", { stage: "worktree_remove", ...errorFields(error) });
        this.warn("git worktree removal failed; retaining session mapping");
        return false;
      }
      try {
        unlinkEmptyDirectory(session.worktreeRoot);
      } catch {
        // A root containing another managed worktree is expected to remain.
      }
      if (session.branch) {
        const head = gitOutputOrEmpty(session.workspaceRoot, ["rev-parse", "--verify", session.branch]);
        if (head && head === session.baseCommit) gitStatusCode(session.workspaceRoot, ["branch", "-d", session.branch]);
        else if (head) this.info(`keeping committed muximo branch '${session.branch}'`);
      }
    }
    await this.sessions.delete(session.id);
    this.audit("agent_session.deleted", session.id, { name: session.name });
    logger.debug("session.deleted", { force, durationMs: Date.now() - startedAt });
    this.removeHookOutputs(session);
    await this.disposeOpenCodeServerIfUnused(session);
    return true;
  }

  /**
   * Release the owned OpenCode server for a project root once no managed
   * OpenCode session still targets that root. The port is freed and the
   * sidecar is stopped only when Muximo owns it.
   */
  private async disposeOpenCodeServerIfUnused(session: AgentSessionRecord): Promise<void> {
    if (session.backend !== "opencode") return;
    const runDir = session.worktreePath ?? session.workspaceRoot;
    const remaining = (await this.sessions.list(session.workspaceId)).some(
      (candidate) => candidate.backend === "opencode" && (candidate.worktreePath ?? candidate.workspaceRoot) === runDir,
    );
    if (remaining) return;
    try {
      const manager = new OpenCodeServerManager({
        registryFile: defaultOpenCodeRegistryFile(this.env),
      });
      await manager.dispose(runDir);
    } catch (error) {
      this.warn(
        `OpenCode server release failed for '${runDir}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private removeHookOutputs(session: AgentSessionRecord): void {
    for (const path of [session.setupOutputFile, session.cleanupOutputFile]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        // Hook output is an artifact, not lifecycle state. A missing file is harmless.
      }
    }
    unlinkEmptyDirectory(join(this.hookOutputRoot, session.id));
  }

  private worktreeIsRegistered(session: AgentSessionRecord): boolean {
    if (!session.worktreePath) return false;
    return gitOutputOrEmpty(session.workspaceRoot, ["worktree", "list", "--porcelain"])
      .split("\n")
      .some((line) => line === `worktree ${session.worktreePath}`);
  }

  private worktreeHasAgentChanges(session: AgentSessionRecord): boolean {
    if (!session.worktreePath || !existsSync(session.worktreePath)) return false;
    const current = this.gitStatus(session.worktreePath);
    return current !== (session.baselineStatus ?? "");
  }

  private gitStatus(cwd: string): string {
    return gitOutputRaw(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  }

  private async captureCodexSessionBaseline(session: AgentSessionRecord): Promise<boolean> {
    if (session.backend !== "codex") return true;
    const startedAt = Date.now();
    const logger = this.currentLogger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
    });
    logger.debug("codex.baseline_started");
    const files = await this.codexSessionFiles();
    const baseline = files
      .map((file) => codexMeta(file)?.session_id)
      .filter((value): value is string => Boolean(value));
    // Baselines are persisted in the same database record as a newline list so
    // a restart never depends on an auxiliary state file.
    session = updateSession(session, { codexSessionBaseline: JSON.stringify({ codexSessions: baseline }) });
    await this.sessions.update(session);
    logger.debug("codex.baseline_finished", {
      fileCount: files.length,
      sessionCount: baseline.length,
      durationMs: Date.now() - startedAt,
    });
    return true;
  }

  private async discoverCodexSessionId(
    startedAt: number,
    runDir: string,
    sessionId: string,
    endedAt?: number,
  ): Promise<CodexDiscoveryResult> {
    const session = await this.sessions.findById(AgentSessionId.create(sessionId));
    const logger = this.currentLogger.child({ sessionId, backend: "codex" });
    const discoveryStartedAt = Date.now();
    logger.debug("codex.session_id_discovery_started", { remote: Boolean(session?.codexRemote) });
    const baseline = new Set<string>(readCodexBaseline(session?.codexSessionBaseline));
    const started = Date.now();
    const root = this.codexSessionRoot();
    const candidates = this.codexSessionCandidates(
      await this.codexSessionFiles(),
      startedAt,
      runDir,
      baseline,
      endedAt,
    );
    const safeCandidates = await this.filterCodexSessionCandidates(
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

  private async filterCodexSessionCandidates(
    candidates: CodexSessionCandidate[],
    diagnostics: Omit<CodexDiscoveryDiagnostics, "rootExists" | "elapsedMs">,
    session: AgentSessionRecord | undefined,
    runDir: string,
  ): Promise<CodexSessionCandidate[]> {
    if (!session) return candidates;
    const sessions = await this.sessions.list(session.workspaceId);
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

  private async recoverCodexSessionId(session: AgentSessionRecord, runDir: string): Promise<CodexDiscoveryResult> {
    const createdAt = Date.parse(session.createdAt);
    if (!Number.isFinite(createdAt)) {
      return {
        candidates: [],
        diagnostics: emptyCodexDiscoveryDiagnostics(existsSync(this.codexSessionRoot())),
      };
    }
    const updatedAt = session.lastExitStatus === undefined ? Number.NaN : Date.parse(session.updatedAt);
    const result = await this.discoverCodexSessionId(
      Math.floor(createdAt / 1_000),
      runDir,
      session.id,
      Number.isFinite(updatedAt) ? updatedAt / 1_000 : undefined,
    );
    if (result.candidates.length === 1) return { ...result, selectedId: result.candidates[0]?.id };
    const ownershipRejected =
      (result.diagnostics.rejected.known_to_other_session ?? 0) + (result.diagnostics.rejected.competing_session ?? 0);
    if (result.candidates.length > 1 || ownershipRejected > 0) {
      this.warn(
        `cannot safely recover Codex session ID for '${session.name}'; found ${result.diagnostics.candidateFiles} matching rollouts (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`,
      );
    } else {
      this.warn(
        `cannot recover Codex session ID for '${session.name}' (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`,
      );
    }
    return { ...result, selectedId: undefined };
  }

  private async repairCodexSessionId(
    session: AgentSessionRecord,
    runDir: string,
    phase: "resume",
  ): Promise<AgentSessionRecord> {
    if (session.backend !== "codex" || session.backendSessionId) return session;
    const result = await this.recoverCodexSessionId(session, runDir);
    if (!result.selectedId) {
      this.audit("agent_session.codex_session_id_recovery_failed", session.id, {
        name: session.name,
        phase,
        runDir,
        diagnostics: result.diagnostics,
      });
      return session;
    }
    await this.sessions.setBackendSessionIdIfMissing(session.id, result.selectedId);
    const persisted = await this.sessions.findById(session.id);
    if (!persisted?.backendSessionId)
      throw new MuximoCommandError(`session '${session.name}' disappeared while repairing its backend session ID`);
    this.info(`recovered Codex session ID for '${session.name}' during ${phase}`);
    return persisted;
  }

  private reportCodexDiscoveryFailure(
    session: AgentSessionRecord,
    runDir: string,
    phase: "finalize" | "resume",
    result: CodexDiscoveryResult,
  ): void {
    const diagnostics = formatCodexDiscoveryDiagnostics(result.diagnostics);
    this.warn(
      `Codex session ID could not be found; '${session.name}' cannot be resumed until the mapping is repaired (${diagnostics})`,
    );
    this.audit("agent_session.codex_session_id_missing", session.id, {
      name: session.name,
      phase,
      runDir,
      diagnostics: result.diagnostics,
    });
  }

  private codexSessionCandidates(
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

  private codexSessionRoot(): string {
    return join(this.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  }

  private async codexSessionFiles(): Promise<string[]> {
    const root = this.codexSessionRoot();
    return existsSync(root) ? walkFiles(root).filter((file) => file.endsWith(".jsonl")) : [];
  }

  private watchCodexSessionName(
    session: AgentSessionRecord,
    startedAt: number,
    runDir: string,
  ): { stop: () => Promise<void> } {
    let stopped = false;
    const controller = new AbortController();
    const run = async () => {
      while (!stopped) {
        const discovery = await this.discoverCodexSessionId(startedAt, runDir, session.id);
        if (discovery.selectedId) {
          try {
            await this.sessions.setBackendSessionIdIfMissing(session.id, discovery.selectedId);
            await this.manageRemoteThread(
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

  private async manageRemoteThread(
    session: AgentSessionRecord,
    operation: "name" | "archive" | "unarchive",
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    let result = false;
    const queued = this.remoteOperation.then(async () => {
      if (signal?.aborted) return;
      result = await this.manageRemoteThreadNow(session, operation, signal);
    });
    this.remoteOperation = queued.catch(() => undefined);
    await queued;
    return result;
  }

  private async manageRemoteThreadNow(
    session: AgentSessionRecord,
    operation: "name" | "archive" | "unarchive",
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!session.codexRemote) return true;
    if (session.codexRemote !== "unix://") {
      this.warn(`cannot ${operation} Codex remote thread on unsupported endpoint: ${session.codexRemote}`);
      return false;
    }
    if (!session.backendSessionId) {
      this.warn(`cannot ${operation} Codex remote thread; session ID is missing`);
      return false;
    }
    const logger = this.currentLogger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
      operation,
    });
    const startedAt = Date.now();
    logger.debug("codex.remote_started", { transport: session.codexRemote });
    try {
      const helper = this.env.MUXIMO_CODEX_NAME_BIN;
      if (helper) {
        const executable = resolveExecutable(helper, this.env);
        const args = ["--thread-id", session.backendSessionId, operation === "name" ? "--name" : `--${operation}`];
        if (operation === "name") args.push(session.name);
        const status = await runCodexThreadHelper(executable, args, this.env, signal);
        if (status !== 0) throw new Error(`helper exited with ${status}`);
      } else {
        await manageCodexThread({
          threadId: session.backendSessionId,
          operation,
          name: operation === "name" ? session.name : undefined,
        });
      }
      logger.debug("codex.remote_finished", { success: true, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      logger.debug("codex.remote_failed", {
        success: false,
        ...errorFields(error),
        durationMs: Date.now() - startedAt,
      });
      this.warn(
        `could not ${operation} Codex remote thread '${session.backendSessionId}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async locateSession(reference: string, global: boolean): Promise<AgentSessionRecord> {
    const separatorIndex = reference.indexOf("/");
    if (!global && separatorIndex >= 0)
      throw new MuximoCommandError(`workspace-qualified session references require --global: ${reference}`);
    const selector = separatorIndex >= 0 ? reference.slice(0, separatorIndex) : undefined;
    const requestedName = separatorIndex >= 0 ? reference.slice(separatorIndex + 1) : reference;
    if (requestedName.includes("/")) throw new MuximoCommandError(`invalid session reference: ${reference}`);
    const sessions = await this.sessions.list(global ? undefined : (await this.resolveWorkspace()).id);
    const scopedSessions = sessions.filter(
      (session) => !selector || session.workspaceId === selector || session.workspaceName === selector,
    );
    const exactMatches = scopedSessions.filter((session) => session.name === requestedName);
    if (exactMatches.length === 1) return exactMatches[0]!;
    if (exactMatches.length > 1)
      throw new MuximoCommandError(
        `${global ? "global " : ""}session name is ambiguous; use WORKSPACE/${requestedName}`,
      );

    const name = normalizeSessionName(requestedName);
    const matches = scopedSessions.filter((session) => session.name === name);
    if (matches.length === 0)
      throw new MuximoCommandError(
        global ? `global session not found: ${reference}` : `session not found in this workspace: ${reference}`,
      );
    if (matches.length > 1)
      throw new MuximoCommandError(`${global ? "global " : ""}session name is ambiguous; use WORKSPACE/${name}`);
    return matches[0]!;
  }

  private setTerminalTitle(name: string): void {
    if (this.env.MUXIMO_SET_TERMINAL_TITLE === "0" || !process.stdout.isTTY) return;
    this.io.out.write(`\u001b]0;muximo:${name}\u0007`);
  }

  private restoreTerminalTitle(): void {
    if (this.env.MUXIMO_SET_TERMINAL_TITLE === "0" || !process.stdout.isTTY) return;
    this.io.out.write("\u001b]0;\u0007");
  }

  private audit(eventType: string, entityId: string, payload: unknown): void {
    this.ensureDatabase();
    if (!this.database) throw new MuximoCommandError("database is not available for audit logging");
    recordAuditEvent(this.database.db, { eventType, entityId, payload });
  }

  private ensureDatabase(): void {
    if (this.database) return;
    this.currentLogger.debug("database.opening", { databaseFile: this.databaseFile });
    this.database = createAgentDatabase(this.databaseFile, {
      migrationsFolder: this.env.MUXIMOD_MIGRATIONS_DIR ?? this.env.MUXIMO_MIGRATIONS_DIR,
      instanceDirectory: this.instanceDirectory,
    });
    this.transactionManager =
      this.database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(this.database);
    this.sessions = new DrizzleAgentSessionRepository(this.database.db);
    this.workspaces = new DrizzleWorkspaceRepository(this.database.db);
    this.workspaceCatalog = new WorkspaceSelectionCatalog(["/"], this.cwd);
    const audit = {
      record: (eventType: string, entityId: string, payload: unknown) => this.audit(eventType, entityId, payload),
    };
    const factory = new WorkspaceRecordFactory(this.workspaceCatalog);
    this.workspaceList = new ListWorkspaces(this.workspaces);
    this.workspaceRegister = new RegisterWorkspace(this.workspaces, factory, audit, this.transactionManager);
    this.workspaceUpdate = new UpdateWorkspace(
      this.workspaces,
      this.workspaceCatalog,
      factory,
      audit,
      this.transactionManager,
    );
    this.workspaceDelete = new DeleteWorkspace(this.workspaces, this.workspaceCatalog, audit, this.transactionManager);
    this.currentLogger.debug("database.opened", { databaseFile: this.databaseFile });
  }

  private printUsage(): void {
    this.write(`Usage:
  muximo [-v|--verbose] <command> [OPTIONS]
  muximo tmux new-session [-s NAME] [-c PATH] [--detached]
  muximo shell [--shell PATH] [--exit-after-command] [-- COMMAND...]
  muximo run <codex|claude|opencode> [OPTIONS] [-- BACKEND_ARGS...]
  muximo workspace list [--json]
  muximo workspace add DIRECTORY [OPTIONS]
  muximo workspace update WORKSPACE [OPTIONS]
  muximo workspace delete WORKSPACE [--force]
  muximo session list [--global] [--all] [--names|--json]
  muximo session resume [--global] NAME [-- BACKEND_ARGS...]
  muximo session cleanup [--global] [--force] NAME
  muximo resume [--global] NAME [-- BACKEND_ARGS...]
  muximo list [--global] [--all] [--names|--json]
  muximo cleanup [--global] [--force] NAME
  muximo doctor [--verbose]
  muximo pair [--without-serve] [--muximod-base-url URL] [--control-socket PATH]
  muximo daemon start [--foreground] [--host HOST] [--port PORT] [--pid-file PATH] [--log-level LEVEL] [--log-file PATH]
  muximo daemon restart [--refresh-servers] [--host HOST] [--port PORT] [--pid-file PATH] [--log-level LEVEL] [--log-file PATH]
  muximo daemon <status|stop|ensure> [--host HOST] [--port PORT] [--pid-file PATH] [--log-level LEVEL] [--log-file PATH]
  muximo serve tailscale [--port PORT] [--muximod-port PORT] [--log-level LEVEL] [--log-file PATH]
  muximo dev [serve tailscale]

Global options:
  -v, --verbose           Show detailed diagnostics on the attached terminal.

Lifecycle behavior:
  muximo daemon start backgrounds muximod by default; use --foreground for a service manager.
  muximo daemon restart restarts muximod in the background, keeping running OpenCode servers; use --refresh-servers to restart them on the same ports so configuration changes are picked up.
  muximo serve tailscale starts muximod automatically when needed, then configures Tailscale Serve in the background.

Run options:
  -n, --name NAME          Logical session name; does not create a worktree.
  -w, --worktree [NAME]    Create a managed worktree and muximo/<name> branch (dev uses muximo/<worktree-id>/<name>).
      --no-worktree        Explicitly run in the current workspace.
      --worktree-root PATH Override the managed worktree parent directory.
      --setup-hook PATH     Override the workspace setup hook.
      --cleanup-hook PATH   Override the workspace cleanup hook.
      --no-setup-hook       Disable the workspace setup hook.
      --no-cleanup-hook     Disable the workspace cleanup hook.
      --codex-profile NAME  Select a Codex profile for this session.
`);
  }

  private write(value: string, error = false): void {
    (error ? this.io.err : this.io.out).write(value);
  }

  private info(value: string): void {
    this.write(`muximo: ${value}\n`);
  }

  private warn(value: string): void {
    this.write(`muximo: warning: ${value}\n`, true);
  }
}
