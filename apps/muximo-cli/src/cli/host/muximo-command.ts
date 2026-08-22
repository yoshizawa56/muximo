import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { buildMuximoShellCommand, configureManagedTmuxSession, resolveMuximoCommand, TmuxAdapter } from "@muximo/infrastructure";
import { AgentPluginRegistry, createDefaultAgentPluginRegistry, defaultOpenCodeRegistryFile, openCodeMonitorActions, OpenCodeServerManager, type AgentMonitor, type AgentObservation } from "@muximo/infrastructure";
import { WorkspaceSelectionCatalog, workspaceIdForPath } from "@muximo/infrastructure";
import { MuximodPairingControlAdapter, PairingControlError } from "./muximod-pairing-control-adapter.js";
import { WorkspaceCrud, type UpdateWorkspaceInput } from "@muximo/application";
import type {
  AgentBackend,
  AgentSessionRecord,
  PaneState,
  WorkspaceRecord,
} from "@muximo/domain";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  InvalidAgentSessionNameError,
  isValidWorktreeCopyPattern,
  normalizeAgentSessionName,
  normalizeWorktreeCopyPatterns,
  WorkspaceId,
  type AgentSessionUpdateInput,
  type Patch,
} from "@muximo/domain";
import {
  createLogger,
  errorFields,
  type Logger,
  type LogLevel,
} from "@muximo/infrastructure";
import {
  createAgentDatabase,
  DrizzleAgentSessionRepository,
  DrizzleWorkspaceRepository,
  recordAuditEvent,
  resolveMuximodPaths,
  SqliteTransactionManager,
  type AgentDatabase,
} from "@muximo/infrastructure";
import { manageCodexThread } from "./codex-remote.js";
import {
  projectAgentSession,
  shouldCheckSessionWorktree,
  type SessionListProjection,
  type SessionWorktreeState,
} from "./session-list.js";

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

type ProcessResult = {
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

type CodexSessionCandidate = {
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

type CodexDiscoveryDiagnostics = {
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

type CodexMeta = {
  session_id?: string;
  id?: string;
  cwd?: string;
  originator?: string;
  thread_source?: string;
};

type CodexMetaInspection = {
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

type TmuxNewSessionOptions = {
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

type WorkspaceListOptions = {
  json: boolean;
};

type SessionListOptions = {
  global: boolean;
  names: boolean;
  json: boolean;
  all: boolean;
};

type GitWorktreeRegistry =
  | { ok: true; paths: ReadonlySet<string> }
  | { ok: false };

type WorkspaceMutationOptions = {
  selector?: string;
  directory?: string;
  name?: string;
  nameExplicit: boolean;
  setupHook?: string | null;
  setupHookExplicit: boolean;
  cleanupHook?: string | null;
  cleanupHookExplicit: boolean;
  copyPatterns: string[];
  copyPatternsExplicit: boolean;
  appendCopyPatterns: string[];
  clearCopyPatterns: boolean;
};

type WorkspaceDeleteOptions = {
  selector: string;
};

const sessionNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,63}$/u;
const supportedCodexOriginators = new Set([
  "codex-tui",
  "codex_cli_rs",
  "codex_exec",
  "codex_chatgpt_ios_remote",
]);

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
  private workspaceCrud!: WorkspaceCrud;

  public constructor(options: MuximoCommandOptions = {}) {
    this.cwd = realpathSafe(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...options.env };
    this.io = options.io ?? { out: process.stdout, err: process.stderr };
    this.ownsLogger = !options.logger;
    this.logger = options.logger ?? createLogger({
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
    this.instanceDirectory = this.databaseFile === ":memory:" || (configuredDatabaseFile?.trim() && !this.env.MUXIMOD_INSTANCE_DIR?.trim())
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
          if (backend !== "codex" && backend !== "claude" && backend !== "opencode") throw new MuximoCommandError("run requires codex, claude, or opencode");
          status = await this.runSession(backend, this.parseRunOptions(backend, args.slice(2)));
          break;
        }
        case "shell":
          if (args.includes("-h") || args.includes("--help")) {
            this.write("Usage: muximo shell [--shell PATH] [--worktree [NAME]] [--exit-after-command] [-- COMMAND...]\n");
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
      } else if (argument === "--setup-task" || argument === "--cleanup-task" || argument.startsWith("--setup-task=") || argument.startsWith("--cleanup-task=")) {
        throw new MuximoCommandError(`${argument} is no longer supported; use workspace hooks or --setup-hook/--cleanup-hook`);
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

    if (exitAfterCommand && command.length === 0) throw new MuximoCommandError("--exit-after-command requires a command after --");
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
          setupHook: workspace.setupScriptPath ? this.resolveHookPath(workspace.setupScriptPath, workspace.rootPath) : null,
          cleanupHook: workspace.cleanupScriptPath ? this.resolveHookPath(workspace.cleanupScriptPath, workspace.rootPath) : null,
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
      return await spawnAttached(shellBinary, ["-i"], shellCwd, interactiveShellEnvironment).then((result) => result.code);
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
    if (this.tmux.hasSession(options.name)) throw new MuximoCommandError(`tmux session already exists: ${options.name}`);

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
    const [subcommand = "", ...rest] = args;
    if (subcommand === "" || subcommand === "-h" || subcommand === "--help") {
      this.write("Usage: muximo workspace <list|add|register|update|delete> [OPTIONS]\n");
      return subcommand === "" ? 2 : 0;
    }

    switch (subcommand) {
      case "list":
        if (rest.includes("-h") || rest.includes("--help")) {
          this.write("Usage: muximo workspace list [--json]\n");
          return 0;
        }
        return this.listWorkspaces(this.parseWorkspaceListOptions(rest));
      case "add":
      case "register":
        if (rest.includes("-h") || rest.includes("--help")) {
          this.write(workspaceAddUsage(subcommand));
          return 0;
        }
        return this.addWorkspace(this.parseWorkspaceMutationOptions(rest, "add"));
      case "update":
        if (rest.includes("-h") || rest.includes("--help")) {
          this.write(workspaceUpdateUsage());
          return 0;
        }
        return this.updateWorkspace(this.parseWorkspaceMutationOptions(rest, "update"));
      case "delete":
      case "remove":
      case "rm":
        if (rest.includes("-h") || rest.includes("--help")) {
          this.write("Usage: muximo workspace delete WORKSPACE [--force]\n");
          return 0;
        }
        return this.deleteWorkspace(this.parseWorkspaceDeleteOptions(rest));
      default:
        throw new MuximoCommandError(`unknown workspace command: ${subcommand}`);
    }
  }

  private parseWorkspaceListOptions(args: string[]): WorkspaceListOptions {
    let json = false;
    for (const argument of args) {
      if (argument === "--json") json = true;
      else throw new MuximoCommandError(`unknown workspace list option: ${argument}`);
    }
    return { json };
  }

  private parseWorkspaceMutationOptions(args: string[], mode: "add" | "update"): WorkspaceMutationOptions {
    let selector: string | undefined;
    let directory: string | undefined;
    let name: string | undefined;
    let nameExplicit = false;
    let setupHook: string | null | undefined;
    let setupHookExplicit = false;
    let cleanupHook: string | null | undefined;
    let cleanupHookExplicit = false;
    const copyPatterns: string[] = [];
    let copyPatternsExplicit = false;
    const appendCopyPatterns: string[] = [];
    let clearCopyPatterns = false;

    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === "--name") {
        name = requireOptionValue(argument, args[++index]);
        nameExplicit = true;
      } else if (argument.startsWith("--name=")) {
        name = requireOptionValue("--name", argument.slice("--name=".length));
        nameExplicit = true;
      } else if (argument === "--directory" || argument === "--path") {
        if (mode === "update") throw new MuximoCommandError("workspace directory is immutable; delete and add a new registration");
        directory = requireOptionValue(argument, args[++index]);
      } else if (argument.startsWith("--directory=") || argument.startsWith("--path=")) {
        if (mode === "update") throw new MuximoCommandError("workspace directory is immutable; delete and add a new registration");
        const option = argument.startsWith("--directory=") ? "--directory" : "--path";
        directory = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
      } else if (argument === "--setup-hook" || argument === "--setup-script" || argument === "--setup-script-path") {
        setupHook = requireOptionValue(argument, args[++index]);
        setupHookExplicit = true;
      } else if (argument.startsWith("--setup-hook=") || argument.startsWith("--setup-script=") || argument.startsWith("--setup-script-path=")) {
        const option = argument.startsWith("--setup-hook=")
          ? "--setup-hook"
          : argument.startsWith("--setup-script=") ? "--setup-script" : "--setup-script-path";
        setupHook = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
        setupHookExplicit = true;
      } else if (argument === "--no-setup-hook" || argument === "--no-setup-script") {
        setupHook = null;
        setupHookExplicit = true;
      } else if (argument === "--cleanup-hook" || argument === "--cleanup-script" || argument === "--cleanup-script-path") {
        cleanupHook = requireOptionValue(argument, args[++index]);
        cleanupHookExplicit = true;
      } else if (argument.startsWith("--cleanup-hook=") || argument.startsWith("--cleanup-script=") || argument.startsWith("--cleanup-script-path=")) {
        const option = argument.startsWith("--cleanup-hook=")
          ? "--cleanup-hook"
          : argument.startsWith("--cleanup-script=") ? "--cleanup-script" : "--cleanup-script-path";
        cleanupHook = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
        cleanupHookExplicit = true;
      } else if (argument === "--no-cleanup-hook" || argument === "--no-cleanup-script") {
        cleanupHook = null;
        cleanupHookExplicit = true;
      } else if (argument === "--copy-pattern" || argument === "--worktree-copy-pattern" || argument === "--copy") {
        copyPatterns.push(requireOptionValue(argument, args[++index]));
        copyPatternsExplicit = true;
      } else if (argument.startsWith("--copy-pattern=") || argument.startsWith("--worktree-copy-pattern=") || argument.startsWith("--copy=")) {
        copyPatterns.push(requireOptionValue("--copy-pattern", argument.slice(argument.indexOf("=") + 1)));
        copyPatternsExplicit = true;
      } else if (argument === "--add-copy-pattern" || argument === "--append-copy-pattern") {
        appendCopyPatterns.push(requireOptionValue(argument, args[++index]));
      } else if (argument.startsWith("--add-copy-pattern=") || argument.startsWith("--append-copy-pattern=")) {
        appendCopyPatterns.push(requireOptionValue("--add-copy-pattern", argument.slice(argument.indexOf("=") + 1)));
      } else if (argument === "--clear-copy-patterns" || argument === "--no-copy-patterns") {
        clearCopyPatterns = true;
      } else if (argument.startsWith("-")) {
        throw new MuximoCommandError(`unknown workspace ${mode} option: ${argument}`);
      } else if (mode === "add" && !directory) {
        directory = argument;
      } else if (mode === "update" && !selector) {
        selector = argument;
      } else {
        throw new MuximoCommandError(`workspace ${mode} accepts exactly one ${mode === "add" ? "directory" : "workspace selector"}`);
      }
    }

    if (mode === "add" && !directory) throw new MuximoCommandError("workspace add requires a directory");
    if (mode === "update" && !selector) throw new MuximoCommandError("workspace update requires a workspace selector");
    if (mode === "add" && (appendCopyPatterns.length > 0 || clearCopyPatterns)) {
      throw new MuximoCommandError("--add-copy-pattern and --clear-copy-patterns are only valid for workspace update");
    }
    if (copyPatternsExplicit && clearCopyPatterns) throw new MuximoCommandError("--clear-copy-patterns cannot be combined with --copy-pattern");
    return {
      selector,
      directory,
      name,
      nameExplicit,
      setupHook,
      setupHookExplicit,
      cleanupHook,
      cleanupHookExplicit,
      copyPatterns,
      copyPatternsExplicit,
      appendCopyPatterns,
      clearCopyPatterns,
    };
  }

  private parseWorkspaceDeleteOptions(args: string[]): WorkspaceDeleteOptions {
    let selector: string | undefined;
    for (const argument of args) {
      if (argument === "--force" || argument === "--yes") continue;
      if (argument.startsWith("-")) throw new MuximoCommandError(`unknown workspace delete option: ${argument}`);
      if (selector) throw new MuximoCommandError("workspace delete accepts exactly one workspace selector");
      selector = argument;
    }
    if (!selector) throw new MuximoCommandError("workspace delete requires a workspace selector");
    return { selector };
  }

  private async listWorkspaces(options: WorkspaceListOptions): Promise<number> {
    const workspaces = await this.runWorkspaceUseCase(() => this.workspaceCrud.list.execute());
    if (options.json) {
      for (const workspace of workspaces) this.write(`${JSON.stringify(toWorkspaceJson(workspace))}\n`);
      return 0;
    }

    this.write(padHeader(["ID", "NAME", "DIRECTORY", "GIT", "SETUP_HOOK", "CLEANUP_HOOK", "COPY_PATTERNS"]));
    if (workspaces.length === 0) {
      this.info("no registered workspaces");
      return 0;
    }
    for (const workspace of workspaces) {
      this.write(padRow([
        workspace.id,
        workspace.name,
        displayWorkspacePath(workspace.rootPath),
        workspace.isGit ? "yes" : "no",
        workspace.setupScriptPath ? displayWorkspacePath(workspace.setupScriptPath) : "-",
        workspace.cleanupScriptPath ? displayWorkspacePath(workspace.cleanupScriptPath) : "-",
        workspace.worktreeCopyPatterns.length > 0 ? workspace.worktreeCopyPatterns.join(",") : "-",
      ]));
    }
    return 0;
  }

  private async addWorkspace(options: WorkspaceMutationOptions): Promise<number> {
    const workspace = await this.runWorkspaceUseCase(() => this.workspaceCrud.register.execute({
      directory: options.directory!,
      name: options.nameExplicit ? options.name : undefined,
      setupHook: options.setupHookExplicit ? toWorkspacePatch(options.setupHook) : undefined,
      cleanupHook: options.cleanupHookExplicit ? toWorkspacePatch(options.cleanupHook) : undefined,
      worktreeCopyPatterns: options.copyPatternsExplicit ? options.copyPatterns : undefined,
    }));
    this.info(`workspace '${workspace.name}' added (${displayWorkspacePath(workspace.rootPath)})`);
    return 0;
  }

  private async updateWorkspace(options: WorkspaceMutationOptions): Promise<number> {
    const input: UpdateWorkspaceInput = {
      name: options.nameExplicit ? options.name : undefined,
      setupHook: options.setupHookExplicit ? toWorkspacePatch(options.setupHook) : undefined,
      cleanupHook: options.cleanupHookExplicit ? toWorkspacePatch(options.cleanupHook) : undefined,
      worktreeCopyPatterns: options.copyPatternsExplicit ? options.copyPatterns : undefined,
      appendCopyPatterns: options.appendCopyPatterns,
      clearCopyPatterns: options.clearCopyPatterns,
    };
    const workspace = await this.runWorkspaceUseCase(() => this.workspaceCrud.update.execute(options.selector!, input));
    this.info(`workspace '${workspace.name}' updated`);
    return 0;
  }

  private async deleteWorkspace(options: WorkspaceDeleteOptions): Promise<number> {
    const workspace = await this.runWorkspaceUseCase(() => this.workspaceCrud.delete.execute(options.selector));
    this.info(`workspace '${workspace.name}' unregistered; directory was not deleted`);
    return 0;
  }

  private async runWorkspaceUseCase<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MuximoCommandError) throw error;
      throw new MuximoCommandError(error instanceof Error ? error.message : String(error));
    }
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
    this.markCurrentPane({
      kind: "shell",
      agentId: null,
      name: environment.MUXIMOD_PANE_NAME ?? environment.MUXIMOD_MANAGED_SESSION_NAME ?? "shell",
    }, environment);
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
        this.write("Usage: muximo list [--global] [--all] [--names|--json]\n");
        return { global, names: false, json: false, all: false };
      } else throw new MuximoCommandError(`unknown list option: ${argument}`);
    }
    if (names && json) throw new MuximoCommandError("--names and --json cannot be combined");
    return { global, names, json, all };
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
      const helpArgs = backend === "codex" && options.codexProfile && !hasOption("--profile", options.backendArgs) && !hasOption("-p", options.backendArgs)
        ? ["--profile", options.codexProfile, ...options.backendArgs]
        : options.backendArgs;
      logger.debug("backend.help_started", { argumentCount: helpArgs.length });
      const status = await runAttachedProcess(backendBinary, helpArgs, this.cwd, this.env, logger, "backend_help");
      logger.debug("backend.help_finished", { status, durationMs: Date.now() - sessionStartedAt });
      return status;
    }

    this.ensureDatabase();
    await ensureCodexRemoteControl(backend, options.backendArgs, backendBinary, this.defaultCodexRemote, this.env, logger);
    const workspace = await this.resolveWorkspace();
    logger.debug("workspace.resolved", {
      workspaceId: workspace.id,
      isGit: workspace.isGit,
    });
    const setupHook = options.setupHookExplicit
      ? (options.setupHook ? this.resolveHookPath(options.setupHook, workspace.rootPath) : undefined)
      : options.useWorktree ? this.resolveStoredHook(workspace.setupScriptPath) : undefined;
    const cleanupHook = options.cleanupHookExplicit
      ? (options.cleanupHook ? this.resolveHookPath(options.cleanupHook, workspace.rootPath) : undefined)
      : options.useWorktree ? this.resolveStoredHook(workspace.cleanupScriptPath) : undefined;

    const name = normalizeSessionName(options.name ?? await this.generateName(workspace.id, backend));
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
    const claudeBackendSessionId = backend === "claude" ? optionValue("--session-id", options.backendArgs) ?? randomUUID() : undefined;
    const codexRemote = backend === "codex" ? codexRemoteEndpoint(options.backendArgs, this.defaultCodexRemote) : undefined;
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
    if (current.useWorktree) current = updateSession(current, { baselineStatus: this.gitStatus(current.worktreePath!) });
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
    current = updateSession(current, { status: "running", ...(claudeBackendSessionId === undefined ? {} : { backendSessionId: claudeBackendSessionId }) });
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
      await this.publishAgentObservation(current, result.interrupted ? "stopped" : result.code === 0 ? "completed" : "failed");
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
    if (session.status === "setup_failed") throw new MuximoCommandError(`session '${session.name}' has a failed setup; clean it up before retrying`);
    if (session.status === "starting" || session.status === "setup" || session.status === "ready") {
      throw new MuximoCommandError(`session '${session.name}' has not started its backend; rerun it instead of resuming`);
    }
    const runDir = session.worktreePath ?? session.workspaceRoot;
    if (!existsSync(runDir)) throw new MuximoCommandError(`session working directory is missing: ${runDir}`);
    if (session.useWorktree && !this.worktreeIsRegistered(session)) throw new MuximoCommandError(`managed worktree is no longer registered: ${session.worktreePath}`);
    if (!session.backendSessionId && session.backend === "codex") {
      session = await this.repairCodexSessionId(session, runDir, "resume");
    }
    if (!session.backendSessionId) throw new MuximoCommandError(`session '${session.name}' has no backend session ID; it cannot be resumed`);
    const backendBinary = resolveBackendCommand(session.backend, this.env);
    logger.debug("backend.resolved", { executable: basename(backendBinary) });
    await ensureCodexRemoteControl(session.backend, options.backendArgs, backendBinary, session.codexRemote ?? this.defaultCodexRemote, this.env, logger);
    if (session.executionPid !== undefined && isProcessAlive(session.executionPid)) {
      throw new MuximoCommandError(`session '${session.name}' is already running (pid ${session.executionPid})`);
    }
    const executionId = randomUUID();
    const executionStartedAt = timestamp();
    const claimed = await this.sessions.claimExecution(session.id, session.executionPid ?? null, executionId, process.pid, executionStartedAt);
    if (!claimed) throw new MuximoCommandError(`session '${session.name}' is already being resumed`);
    const current = updateSession(session, { status: "resuming", resuming: true, executionId, executionPid: process.pid, executionStartedAt });
    await this.sessions.update(current);
    let launch: BackendLaunch;
    try {
      launch = await this.createBackendLaunch(current, options.backendArgs, backendBinary, runDir, logger, true);
    } catch (error) {
      logger.debug("session.launch_failed", { ...errorFields(error) });
      await this.sessions.update(updateSession(current, { status: "exited", lastExitStatus: 1 })).catch(() => undefined);
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
      await this.publishAgentObservation(current, result.interrupted ? "stopped" : result.code === 0 ? "completed" : "failed");
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
      this.warn(`muximod could not adopt pane ${tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`);
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
      this.warn(`muximod could not release pane ${tmuxPaneId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async publishAgentObservation(session: AgentSessionRecord, state: PaneState, recentOutput?: string): Promise<void> {
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
    const logger = this.currentLogger.child({ command: "list" });
    const startedAt = Date.now();
    logger.debug("session.list_started", {
      global: options.global,
      names: options.names,
      json: options.json,
      all: options.all,
    });
    const workspace = options.global ? undefined : (await this.resolveWorkspace()).id;
    const allViews = this.projectSessionList(await this.sessions.list(workspace));
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
        this.write(`${options.global ? `${session.workspaceName}/` : ""}${session.name}\n`);
      }
      return finish(0);
    }
    if (options.json) {
      for (const view of views) this.write(`${JSON.stringify(toSessionJson(view))}\n`);
      return finish(0);
    }
    if (options.global) this.write(padHeader(["WORKSPACE", "NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
    else this.write(padHeader(["NAME", "BACKEND", "STATUS", "HEALTH", "RESUME", "BRANCH", "WORKTREE"]));
    if (views.length === 0) {
      this.info(allViews.length === 0 ? "no managed sessions" : "no visible managed sessions; use --all to include unavailable sessions");
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
      this.write(options.global ? padRow([session.workspaceName, ...values]) : padRow(values));
    }
    return finish(0);
  }

  private projectSessionList(sessions: AgentSessionRecord[]): SessionListProjection[] {
    const now = Date.now();
    const registries = new Map<string, GitWorktreeRegistry>();
    return sessions.map((session) => {
      const processAlive = (session.status === "running" || session.status === "resuming")
        && session.executionPid !== undefined
        ? isProcessAlive(session.executionPid)
        : undefined;
      return projectAgentSession(session, {
        now,
        processAlive,
        worktreeState: this.inspectSessionWorktree(session, now, registries),
      });
    });
  }

  private inspectSessionWorktree(
    session: AgentSessionRecord,
    now: number,
    registries: Map<string, GitWorktreeRegistry>,
  ): SessionWorktreeState {
    if (!session.useWorktree) return "not_applicable";
    if (!shouldCheckSessionWorktree(session, now)) return "unknown";
    if (!session.worktreePath || !existsSync(session.worktreePath)) return "missing";

    const workspaceRoot = realpathSafe(session.workspaceRoot);
    let registry = registries.get(workspaceRoot);
    if (!registry) {
      registry = this.readGitWorktreeRegistry(workspaceRoot);
      registries.set(workspaceRoot, registry);
    }
    if (!registry.ok) return "unknown";
    return registry.paths.has(realpathSafe(session.worktreePath)) ? "available" : "unregistered";
  }

  private readGitWorktreeRegistry(workspaceRoot: string): GitWorktreeRegistry {
    try {
      const output = execFileSync("git", ["-C", workspaceRoot, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
        env: this.env,
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

  private async cleanupSession(options: { global: boolean; force: boolean; reference: string }): Promise<number> {
    const logger = this.currentLogger.child({ command: "cleanup" });
    const startedAt = Date.now();
    logger.debug("session.cleanup_requested", { global: options.global, force: options.force });
    const session = await this.locateSession(options.reference, options.global);
    const sessionLogger = logger.child({
      sessionId: session.id,
      sessionName: session.name,
      workspaceId: session.workspaceId,
      backend: session.backend,
    });
    if (session.executionPid !== undefined && isProcessAlive(session.executionPid)) {
      throw new MuximoCommandError(`session '${session.name}' is still running (pid ${session.executionPid})`);
    }
    if (session.useWorktree && session.worktreePath && existsSync(session.worktreePath)) {
      if (!this.worktreeIsRegistered(session)) throw new MuximoCommandError(`managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`);
    }
    const dirty = session.useWorktree && session.worktreePath ? this.worktreeHasAgentChanges(session) : false;
    let force = options.force;
    sessionLogger.debug("session.cleanup_decision_started", { dirty, force });
    if (session.useWorktree && !force && !(await this.confirmCleanup(session, dirty))) {
      sessionLogger.debug("session.cleanup_declined", { dirty });
      this.info(`cleanup cancelled; session '${session.name}' was kept`);
      return 0;
    }
    if (dirty) force = true;
    if (!(await this.removeSessionRecord(session, force))) {
      sessionLogger.debug("session.cleanup_failed", { dirty, force, durationMs: Date.now() - startedAt });
      this.info(`session '${session.name}' retained because cleanup did not complete`);
      return 1;
    }
    sessionLogger.debug("session.cleanup_finished", { dirty, force, durationMs: Date.now() - startedAt });
    this.info(`session '${session.name}' cleaned up`);
    return 0;
  }

  private async doctor(options: { verbose: boolean }): Promise<number> {
    const logger = this.currentLogger.child({ command: "doctor" });
    const startedAt = Date.now();
    logger.debug("doctor.started", { verbose: options.verbose });
    let status = 0;
    for (const command of ["git", "zsh", "codex", "claude", "opencode"]) {
      const path = commandPath(command, this.env);
      logger.debug("doctor.command_checked", { command, available: Boolean(path) });
      if (path) this.write(`${command}: ${path}\n`);
      else {
        this.write(`${command}: missing\n`, true);
        status = 1;
      }
    }
    const configuredProfile = this.env.MUXIMO_CODEX_PROFILE || null;
    if (configuredProfile) {
      const profilePath = join(this.env.CODEX_HOME ?? join(homedir(), ".codex"), `${configuredProfile}.config.toml`);
      if (existsSync(profilePath)) {
        this.write(`codex profile: ${profilePath}\n`);
        const codex = commandPath("codex", this.env);
        const validationStartedAt = Date.now();
        const validation = codex
          ? spawnSync(codex, ["--profile", configuredProfile, "--strict-config", "--help"], { stdio: "ignore", env: this.env })
          : undefined;
        logger.debug("doctor.codex_profile_checked", {
          available: Boolean(codex),
          exitCode: validation?.status ?? null,
          durationMs: Date.now() - validationStartedAt,
        });
        if (codex && validation?.status !== 0) {
          this.write("codex profile validation: failed\n", true);
          status = 1;
        } else this.write("codex profile validation: ok\n");
      } else {
        this.write(`codex profile: missing (${profilePath})\n`, true);
        status = 1;
      }
    } else {
      this.write("codex profile: not configured\n");
    }
    const mise = commandPath("mise", this.env);
    this.write(mise ? `mise: ${mise}\n` : "mise: unavailable (not required for workspace hooks)\n");
    if (options.verbose) {
      this.write(`database: ${this.databaseFile}\n`);
      this.write(`codex remote: ${this.defaultCodexRemote || "native local mode"}\n`);
      this.write(`worktree root pattern: <workspace-parent>/<workspace-name>.worktrees${this.env.MUXIMO_WORKTREE_ID ? `/${this.env.MUXIMO_WORKTREE_ID}` : ""}/<session-name>\n`);
    }
    logger.debug("doctor.finished", { status, durationMs: Date.now() - startedAt });
    return status;
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
    const existing = await this.workspaces.findById(id) ?? await this.findRegisteredWorkspaceForCwd(root);
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

  private createWorktree(workspace: WorkspaceContext, name: string, override?: string): Pick<AgentSessionRecord, "worktreeRoot" | "worktreePath" | "branch" | "baseCommit"> {
    if (!workspace.isGit) throw new MuximoCommandError("a managed worktree requires a git workspace; use --no-worktree here");
    const defaultRoot = this.env.MUXIMO_WORKTREE_ROOT ?? join(dirname(workspace.rootPath), `${workspace.name}.worktrees`);
    const configuredRoot = override ?? (this.env.MUXIMO_WORKTREE_ID ? join(defaultRoot, this.env.MUXIMO_WORKTREE_ID) : defaultRoot);
    const worktreeRoot = realpathAfterMkdir(resolveFromRoot(configuredRoot, workspace.rootPath));
    const worktreePath = join(worktreeRoot, name);
    let branch = this.worktreeBranch(name);
    const baseCommit = gitRequired(workspace.rootPath, ["rev-parse", "HEAD"], "cannot determine the workspace HEAD");
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) {
      branch = `muximo/${this.env.MUXIMO_WORKTREE_ID ?? workspace.id}/${name}`;
    }
    if (gitStatusCode(workspace.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) === 0) throw new MuximoCommandError(`muximo branch already exists; choose another name or remove it manually: ${branch}`);
    if (existsSync(worktreePath)) throw new MuximoCommandError(`worktree path already exists: ${worktreePath}`);
    this.currentLogger.debug("worktree.create_started", {
      workspaceId: workspace.id,
      worktreePath,
      branch,
    });
    this.info(`creating worktree '${worktreePath}'`);
    gitRequired(workspace.rootPath, ["worktree", "add", "-b", branch, "--", worktreePath, baseCommit], "git worktree creation failed");
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
        this.warn(`could not copy unmanaged file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
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
    const next = updateSession(session, kind === "setup" ? { setupOutputFile: finalOutput } : { cleanupOutputFile: finalOutput });
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
      this.warn(`shell worktree has uncommitted changes; keeping it: ${ctx.worktreePath} (branch ${ctx.branch ?? "unknown"})`);
      return;
    }
    try {
      gitRequired(ctx.workspaceRoot, ["worktree", "remove", "--", ctx.worktreePath], "git worktree removal failed");
    } catch (error) {
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
    return gitOutputOrEmpty(workspaceRoot, ["worktree", "list", "--porcelain"]).split("\n").some((line) => line === `worktree ${worktreePath}`);
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
      "--name", input.name,
      "--backend", input.backend,
      "--workspace", input.workspaceRoot,
      "--worktree", input.worktreePath,
      "--session-id", input.backendSessionId,
      "--state-id", input.stateId,
      "--resuming", input.resuming ? "1" : "0",
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

  private outputFileFor(session: AgentSessionRecord, kind: "setup" | "cleanup"): string {
    return this.hookOutputFile(session.id, kind);
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
    const nameWatcher = session.backend === "codex" && session.backendSessionId === undefined && session.codexRemote ? this.watchCodexSessionName(session, startedAt, runDir) : undefined;
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
      result = await spawnAttached(command[0]!, command.slice(1), runDir, {
        ...this.env,
        MUXIMOD_AGENT_SESSION_ID: session.id,
        MUXIMOD_AGENT_ID: session.backend,
      }, {
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
              this.warn(`Claude session launch was not persisted for resume: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          }
          if (session.backend === "opencode" && preparedBackendSessionId) {
            try {
              await this.sessions.update(updateSession(session, { backendSessionId: preparedBackendSessionId }));
            } catch (error) {
              this.warn(`OpenCode session launch was not persisted for resume: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        },
        onError: (error) => logger.debug("subprocess.spawn_failed", {
          kind: "backend",
          executable: basename(command[0] ?? "unknown"),
          ...errorFields(error),
        }),
      });
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
              await plan.monitor!.execute!({ ...openCodeMonitorActions.abort });
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
      this.warn(`OpenCode session abort failed for '${session.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async publishPluginObservation(session: AgentSessionRecord, observation: AgentObservation): Promise<void> {
    if (observation.type !== "state_changed") return;
    await this.publishAgentObservation(session, observation.state, observation.recentOutput);
  }

  private async finalizeSession(session: AgentSessionRecord, result: ProcessResult, startedAt: number, runDir: string, codexBaseline: boolean): Promise<number> {
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
      logger.debug("session.finished", { status: session.status, cleanup: "retained", durationMs: Date.now() - startedAt * 1000 });
      this.info(`session '${session.name}' mapping retained; use 'muximo resume ${session.name}' or 'muximo cleanup ${session.name}'`);
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
    logger.debug("session.finished", { status: session.status, cleanup: "completed", durationMs: Date.now() - startedAt * 1000 });
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
    if (session.useWorktree && session.worktreePath && existsSync(session.worktreePath) && !this.worktreeIsRegistered(session)) {
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
        gitRequired(session.workspaceRoot, ["worktree", "remove", ...(force ? ["--force"] : []), "--", session.worktreePath], "git worktree removal failed");
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
      this.warn(`OpenCode server release failed for '${runDir}': ${error instanceof Error ? error.message : String(error)}`);
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

  private async confirmCleanup(session: AgentSessionRecord, dirty: boolean): Promise<boolean> {
    if (this.env.MUXIMO_ASSUME_YES === "1") return true;
    if (!process.stdin.isTTY && !process.stdout.isTTY) return false;
    const prompt = dirty
      ? `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}' including uncommitted changes? [y/N] `
      : `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}'? [y/N] `;
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await readline.question(prompt);
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      readline.close();
    }
  }

  private worktreeIsRegistered(session: AgentSessionRecord): boolean {
    if (!session.worktreePath) return false;
    return gitOutputOrEmpty(session.workspaceRoot, ["worktree", "list", "--porcelain"]).split("\n").some((line) => line === `worktree ${session.worktreePath}`);
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
    const logger = this.currentLogger.child({ sessionId: session.id, sessionName: session.name, backend: session.backend });
    logger.debug("codex.baseline_started");
    const files = await this.codexSessionFiles();
    const baseline = files.map((file) => codexMeta(file)?.session_id).filter((value): value is string => Boolean(value));
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

  private async discoverCodexSessionId(startedAt: number, runDir: string, sessionId: string, endedAt?: number): Promise<CodexDiscoveryResult> {
    const session = await this.sessions.findById(AgentSessionId.create(sessionId));
    const logger = this.currentLogger.child({ sessionId, backend: "codex" });
    const discoveryStartedAt = Date.now();
    logger.debug("codex.session_id_discovery_started", { remote: Boolean(session?.codexRemote) });
    const baseline = new Set<string>(readCodexBaseline(session?.codexSessionBaseline));
    const started = Date.now();
    const root = this.codexSessionRoot();
    const candidates = this.codexSessionCandidates(await this.codexSessionFiles(), startedAt, runDir, baseline, endedAt);
    const safeCandidates = await this.filterCodexSessionCandidates(candidates.candidates, candidates.diagnostics, session, runDir);
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
    const unboundSameDirectory = otherSessions.some((candidate) =>
      candidate.backend === "codex"
      && !candidate.backendSessionId
      && (candidate.worktreePath ?? candidate.workspaceRoot) === runDir,
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
    if (result.candidates.length === 1) return { ...result, selectedId: result.candidates[0]!.id };
    const ownershipRejected = (result.diagnostics.rejected.known_to_other_session ?? 0) + (result.diagnostics.rejected.competing_session ?? 0);
    if (result.candidates.length > 1 || ownershipRejected > 0) {
      this.warn(`cannot safely recover Codex session ID for '${session.name}'; found ${result.diagnostics.candidateFiles} matching rollouts (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`);
    } else {
      this.warn(`cannot recover Codex session ID for '${session.name}' (${formatCodexDiscoveryDiagnostics(result.diagnostics)})`);
    }
    return { ...result, selectedId: undefined };
  }

  private async repairCodexSessionId(session: AgentSessionRecord, runDir: string, phase: "resume"): Promise<AgentSessionRecord> {
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
    if (!persisted?.backendSessionId) throw new MuximoCommandError(`session '${session.name}' disappeared while repairing its backend session ID`);
    this.info(`recovered Codex session ID for '${session.name}' during ${phase}`);
    return persisted;
  }

  private reportCodexDiscoveryFailure(session: AgentSessionRecord, runDir: string, phase: "finalize" | "resume", result: CodexDiscoveryResult): void {
    const diagnostics = formatCodexDiscoveryDiagnostics(result.diagnostics);
    this.warn(`Codex session ID could not be found; '${session.name}' cannot be resumed until the mapping is repaired (${diagnostics})`);
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
      let stat;
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
      const isNewerSameKind = previous && candidate.rolloutIdMatches === previous.rolloutIdMatches && candidate.mtime > previous.mtime;
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

  private watchCodexSessionName(session: AgentSessionRecord, startedAt: number, runDir: string): { stop: () => Promise<void> } {
    let stopped = false;
    const controller = new AbortController();
    const run = async () => {
      while (!stopped) {
        const discovery = await this.discoverCodexSessionId(startedAt, runDir, session.id);
        if (discovery.selectedId) {
          try {
            await this.sessions.setBackendSessionIdIfMissing(session.id, discovery.selectedId);
            await this.manageRemoteThread({ ...session, backendSessionId: discovery.selectedId }, "name", controller.signal);
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

  private async manageRemoteThread(session: AgentSessionRecord, operation: "name" | "archive" | "unarchive", signal?: AbortSignal): Promise<boolean> {
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

  private async manageRemoteThreadNow(session: AgentSessionRecord, operation: "name" | "archive" | "unarchive", signal?: AbortSignal): Promise<boolean> {
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
        await manageCodexThread({ threadId: session.backendSessionId, operation, name: operation === "name" ? session.name : undefined });
      }
      logger.debug("codex.remote_finished", { success: true, durationMs: Date.now() - startedAt });
      return true;
    } catch (error) {
      logger.debug("codex.remote_failed", { success: false, ...errorFields(error), durationMs: Date.now() - startedAt });
      this.warn(`could not ${operation} Codex remote thread '${session.backendSessionId}': ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async locateSession(reference: string, global: boolean): Promise<AgentSessionRecord> {
    const separatorIndex = reference.indexOf("/");
    if (!global && separatorIndex >= 0) throw new MuximoCommandError(`workspace-qualified session references require --global: ${reference}`);
    const selector = separatorIndex >= 0 ? reference.slice(0, separatorIndex) : undefined;
    const requestedName = separatorIndex >= 0 ? reference.slice(separatorIndex + 1) : reference;
    if (requestedName.includes("/")) throw new MuximoCommandError(`invalid session reference: ${reference}`);
    const sessions = await this.sessions.list(global ? undefined : (await this.resolveWorkspace()).id);
    const scopedSessions = sessions.filter((session) => !selector || session.workspaceId === selector || session.workspaceName === selector);
    const exactMatches = scopedSessions.filter((session) => session.name === requestedName);
    if (exactMatches.length === 1) return exactMatches[0]!;
    if (exactMatches.length > 1) throw new MuximoCommandError(`${global ? "global " : ""}session name is ambiguous; use WORKSPACE/${requestedName}`);

    const name = normalizeSessionName(requestedName);
    const matches = scopedSessions.filter((session) => session.name === name);
    if (matches.length === 0) throw new MuximoCommandError(global ? `global session not found: ${reference}` : `session not found in this workspace: ${reference}`);
    if (matches.length > 1) throw new MuximoCommandError(`${global ? "global " : ""}session name is ambiguous; use WORKSPACE/${name}`);
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
    recordAuditEvent(this.database!.db, { eventType, entityId, payload });
  }

  private ensureDatabase(): void {
    if (this.database) return;
    this.currentLogger.debug("database.opening", { databaseFile: this.databaseFile });
    this.database = createAgentDatabase(this.databaseFile, {
      migrationsFolder: this.env.MUXIMOD_MIGRATIONS_DIR ?? this.env.MUXIMO_MIGRATIONS_DIR,
      instanceDirectory: this.instanceDirectory,
    });
    this.transactionManager = this.database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(this.database);
    this.sessions = new DrizzleAgentSessionRepository(this.database.db);
    this.workspaces = new DrizzleWorkspaceRepository(this.database.db);
    this.workspaceCatalog = new WorkspaceSelectionCatalog(["/"], this.cwd);
    this.workspaceCrud = new WorkspaceCrud(this.workspaces, this.workspaceCatalog, {
      audit: {
        record: (eventType, entityId, payload) => this.audit(eventType, entityId, payload),
      },
      transactionManager: this.transactionManager,
    });
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

export class MuximoCommandError extends Error {}

function toWorkspacePatch(value: string | null | undefined): Patch<string> {
  return value === null ? clearPatch : value;
}

export function buildRunCommand(session: AgentSessionRecord, backendArgs: string[], defaultRemote: string, backendBinary: string): string[] {
  if (session.backend === "codex") {
    const args = [backendBinary];
    if (session.codexProfile && !hasOption("--profile", backendArgs) && !hasOption("-p", backendArgs)) args.push("--profile", session.codexProfile);
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
  if (!hasOption("--permission-mode", backendArgs) && !hasOption("--dangerously-skip-permissions", backendArgs)) args.push("--permission-mode", "auto");
  args.push(...backendArgs);
  return args;
}

export function buildResumeCommand(session: AgentSessionRecord, backendArgs: string[], defaultRemote: string, backendBinary: string): string[] {
  if (!session.backendSessionId) throw new MuximoCommandError("backend session ID is required to resume");
  if (session.backend === "codex") {
    const full = buildRunCommand(AgentSession.update(session, { backendSessionId: clearPatch }), backendArgs, session.codexRemote ?? defaultRemote, backendBinary);
    const backendStart = full.length - backendArgs.length;
    return [...full.slice(0, backendStart), "resume", session.backendSessionId, ...backendArgs];
  }
  return [backendBinary, "--resume", session.backendSessionId, ...backendArgs];
}

function updateSession(session: AgentSessionRecord, changes: AgentSessionUpdateInput): AgentSessionRecord {
  return AgentSession.update(session, { ...changes, updatedAt: timestamp() });
}

function emptyWorktree(): Pick<AgentSessionRecord, "worktreeRoot" | "worktreePath" | "branch" | "baseCommit"> {
  return {};
}

function sessionHealthLabel(health: SessionListProjection["executionHealth"]): string {
  return health === "inactive" ? "-" : health.replaceAll("_", "-");
}

function sessionResumeLabel(resume: SessionListProjection["resume"]): string {
  if (resume === "available") return "yes";
  if (resume === "unavailable") return "no";
  return "?";
}

function toSessionJson(view: SessionListProjection): Record<string, unknown> {
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

function toWorkspaceJson(workspace: WorkspaceRecord): Record<string, unknown> {
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

function workspaceAddUsage(command: string): string {
  return `Usage: muximo workspace ${command} DIRECTORY [--name NAME] [--setup-hook PATH] [--cleanup-hook PATH] [--copy-pattern PATTERN]\n`;
}

function workspaceUpdateUsage(): string {
  return "Usage: muximo workspace update WORKSPACE [--name NAME] [--setup-hook PATH|--no-setup-hook] [--cleanup-hook PATH|--no-cleanup-hook] [--copy-pattern PATTERN|--clear-copy-patterns]\n";
}

function resolveFromRoot(value: string, root: string): string {
  return isAbsolute(value) ? value : resolve(root, value);
}

function displayWorkspacePath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function realpathAfterMkdir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSafe(path);
}

function timestamp(): string {
  return new Date().toISOString();
}

type SessionPaneAdoption = {
  agentSessionId: string;
  tmuxPaneId: string;
  executionId: string;
};

function currentTmuxPane(env: NodeJS.ProcessEnv): string | undefined {
  const pane = env.TMUX && env.TMUX_PANE ? env.TMUX_PANE.trim() : "";
  return /^%[0-9]+$/.test(pane) ? pane : undefined;
}

function defaultControlSocket(env: NodeJS.ProcessEnv, databaseFile: string): string {
  return resolveMuximodPaths(env, { databaseFile }).controlSocket;
}

function isControlSocketUnavailable(error: unknown): boolean {
  if (error instanceof PairingControlError) return error.code.startsWith("control_socket_");
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function setFallbackSessionMetadata(env: NodeJS.ProcessEnv, input: SessionPaneAdoption): void {
  runTmuxMetadataCommand(env, ["set-option", "-p", "-t", input.tmuxPaneId, "@muximod.agent_execution_id", input.executionId]);
  runTmuxMetadataCommand(env, ["set-option", "-p", "-t", input.tmuxPaneId, "@muximod.agent_session_id", input.agentSessionId]);
}

function clearFallbackSessionMetadata(env: NodeJS.ProcessEnv, input: SessionPaneAdoption): boolean {
  const current = runTmuxMetadataCommand(env, ["show-options", "-q", "-p", "-v", "-t", input.tmuxPaneId, "@muximod.agent_execution_id"]);
  if (current.status !== 0 || current.stdout.trim() !== input.executionId) return false;
  runTmuxMetadataCommand(env, ["set-option", "-p", "-u", "-t", input.tmuxPaneId, "@muximod.agent_execution_id"]);
  runTmuxMetadataCommand(env, ["set-option", "-p", "-u", "-t", input.tmuxPaneId, "@muximod.agent_session_id"]);
  return true;
}

function runTmuxMetadataCommand(env: NodeJS.ProcessEnv, args: string[]): { status: number | null; stdout: string } {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function localTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function requireOptionValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new MuximoCommandError(`${option} requires a value`);
  return value;
}

function hasHelpBeforeDelimiter(args: readonly string[]): boolean {
  for (const argument of args) {
    if (argument === "--") return false;
    if (argument === "-h" || argument === "--help") return true;
  }
  return false;
}

function parseTmuxNewSessionOptions(args: string[], defaultCwd: string): TmuxNewSessionOptions {
  let name = "muximod";
  let cwd = defaultCwd;
  let detached = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "-s" || argument === "--name") name = requireOptionValue(argument, args[++index]);
    else if (argument.startsWith("--name=")) name = argument.slice("--name=".length);
    else if (argument === "-c" || argument === "--cwd") cwd = resolveFromRoot(requireOptionValue(argument, args[++index]), defaultCwd);
    else if (argument.startsWith("--cwd=")) cwd = resolveFromRoot(argument.slice("--cwd=".length), defaultCwd);
    else if (argument === "-d" || argument === "--detached") detached = true;
    else throw new MuximoCommandError(`unknown tmux new-session option: ${argument}`);
  }

  validateSessionName(name);
  if (!existsSync(cwd)) throw new MuximoCommandError(`tmux session cwd does not exist: ${cwd}`);
  return { name, cwd: realpathSafe(cwd), detached };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateSessionName(name: string): void {
  if (!sessionNamePattern.test(name)) throw new MuximoCommandError(`invalid session name '${name}'; use 1-64 letters, digits, '.', '_' or '-'`);
}

function normalizeSessionName(value: string): string {
  try {
    const name = normalizeAgentSessionName(value);
    validateSessionName(name);
    return name;
  } catch (error) {
    if (error instanceof InvalidAgentSessionNameError) throw new MuximoCommandError(error.message);
    throw error;
  }
}

function gitWorkspaceRoot(cwd: string): string | undefined {
  try {
    return realpathSafe(execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return undefined;
  }
}

function gitRequired(cwd: string, args: string[], message: string): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new MuximoCommandError(message);
  }
}

function gitOutputRaw(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listUnmanagedFiles(cwd: string): string[] {
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

function matchesWorktreeCopyPattern(pattern: string, path: string): boolean {
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
      result = match(patternIndex + 1, pathIndex)
        || (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    } else {
      result = pathIndex < pathSegments.length
        && matchSegmentPattern(patternSegments[patternIndex]!, pathSegments[pathIndex]!)
        && match(patternIndex + 1, pathIndex + 1);
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

function isPathWithin(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

function gitOutputOrEmpty(cwd: string, args: string[]): string {
  return gitOutputRaw(cwd, args).trim();
}

function gitStatusCode(cwd: string, args: string[]): number {
  return spawnSync("git", ["-C", cwd, ...args], { stdio: "ignore" }).status ?? 1;
}

function commandPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return execFileSync("which", [command], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveBackendCommand(backend: AgentBackend, env: NodeJS.ProcessEnv): string {
  const override = backend === "codex" ? "MUXIMO_CODEX_BIN" : backend === "claude" ? "MUXIMO_CLAUDE_BIN" : "MUXIMO_OPENCODE_BIN";
  return resolveExecutable(env[override] ?? backend, env);
}

function resolveExecutable(value: string, env: NodeJS.ProcessEnv): string {
  if (value.includes("/")) {
    accessSync(value, constants.X_OK);
    return value;
  }
  const path = commandPath(value, env);
  if (!path) throw new MuximoCommandError(`backend executable not found: ${value}`);
  return path;
}

async function ensureCodexRemoteControl(
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
  for (const command of [["app-server", "daemon", "enable-remote-control"], ["app-server", "daemon", "start"]]) {
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

type SpawnHooks = {
  onStarted?: (pid: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

async function spawnAttached(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, hooks: SpawnHooks = {}): Promise<ProcessResult> {
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
    child.once("close", (code, signal) => resolvePromise({
      code: code ?? signalExitCode(signal),
      interrupted,
      pid: child.pid,
      signal,
    }));
  });
  try {
    if (await started) await hooks.onStarted?.(child.pid);
    return await result;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

async function runAttachedProcess(
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
    onStarted: (pid) => logger?.debug("subprocess.started", {
      kind,
      executable: basename(binary),
      pid,
    }),
    onError: (error) => logger?.debug("subprocess.spawn_failed", {
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

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function codexRemoteEndpoint(args: string[], fallback: string): string {
  return optionValue("--remote", args) ?? fallback;
}

function hasOption(name: string, args: string[]): boolean {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function optionValue(name: string, args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    if (argument === name) return args[index + 1];
  }
  return undefined;
}

function readCodexBaseline(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { codexSessions?: unknown };
    return Array.isArray(parsed.codexSessions) ? parsed.codexSessions.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function preferredCodexSessionId(candidates: CodexSessionCandidate[]): string | undefined {
  return candidates.find((candidate) => candidate.rolloutIdMatches)?.id ?? candidates[0]?.id;
}

function emptyCodexDiscoveryDiagnostics(rootExists: boolean): CodexDiscoveryDiagnostics {
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

function formatCodexDiscoveryDiagnostics(diagnostics: CodexDiscoveryDiagnostics): string {
  const rejected = Object.entries(diagnostics.rejected)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",") || "none";
  return `rollout scan: root=${diagnostics.rootExists ? "present" : "missing"}, files=${diagnostics.filesScanned}, session_meta=${diagnostics.sessionMetaFiles}, payload=${diagnostics.payloadMetadataFiles}, flat=${diagnostics.flatMetadataFiles}, baseline_entries=${diagnostics.baselineEntries}, candidate_files=${diagnostics.candidateFiles}, unique_candidates=${diagnostics.uniqueCandidates}, rejected=${rejected}, scan_ms=${diagnostics.elapsedMs}`;
}

function codexMeta(file: string): CodexMeta | undefined {
  return inspectCodexMeta(file).meta;
}

function inspectCodexMeta(file: string): CodexMetaInspection {
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
    const metadata = isPayload ? payload as Record<string, unknown> : record;
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

function readFirstLine(file: string): { line?: string; tooLarge: boolean } {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function runCodexThreadHelper(executable: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<number> {
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

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function unlinkEmptyDirectory(path: string | null | undefined): void {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function padHeader(values: string[]): string {
  return `${values.map((value) => value.padEnd(24)).join(" ").trimEnd()}\n`;
}

function padRow(values: string[]): string {
  return `${values.map((value) => value.padEnd(24)).join(" ").trimEnd()}\n`;
}
