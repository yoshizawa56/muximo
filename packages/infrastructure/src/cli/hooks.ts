import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import type { HookPort, HookResult, ShellHookPort } from "@muximo/application";
import type { AgentBackend, AgentSessionRecord } from "@muximo/domain";
import { errorFields, type Logger } from "../logging/index.js";
import { realpathSafe } from "./filesystem.js";

export type HookAdapterOptions = {
  environment: NodeJS.ProcessEnv;
  cwd: string;
  hookOutputRoot: string;
  logger: Logger;
};

/** Filesystem/process adapter for executable workspace hooks. */
export class WorkspaceHookAdapter implements HookPort, ShellHookPort {
  public constructor(private readonly options: HookAdapterOptions) {}

  public async resolveHook(value: string, workspaceRoot: string): Promise<string> {
    const path = realpathSafe(isAbsolute(value) ? value : join(workspaceRoot, value));
    if (!existsSync(path)) throw new Error(`workspace hook does not exist: ${value}`);
    accessSync(path, constants.X_OK);
    if (!statSync(path).isFile()) throw new Error(`workspace hook is not a file: ${path}`);
    return path;
  }

  public async resolveStoredHook(path: string | undefined): Promise<string | undefined> {
    return path === undefined ? undefined : this.resolveHook(path, this.options.cwd);
  }

  public async run(session: AgentSessionRecord, kind: "setup" | "cleanup"): Promise<HookResult> {
    const hook = kind === "setup" ? session.setupHook : session.cleanupHook;
    if (!hook) return { success: true };
    const success = await this.runCore({
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
    return {
      success,
      sessionUpdate: {
        [kind === "setup" ? "setupOutputFile" : "cleanupOutputFile"]: this.outputFile(session.id, kind),
      },
    };
  }

  public async removeOutputs(session: AgentSessionRecord): Promise<void> {
    for (const path of [session.setupOutputFile, session.cleanupOutputFile]) {
      if (!path) continue;
      try {
        unlinkSync(path);
      } catch {
        // Hook output is an artifact; a missing file is harmless.
      }
    }
    this.removeEmptyDirectory(join(this.options.hookOutputRoot, session.id));
  }

  public async runShell(input: {
    hook: string | null;
    kind: "setup" | "cleanup";
    runDir: string;
    name: string;
    workspaceRoot: string;
    worktreePath: string;
  }): Promise<boolean> {
    if (!input.hook) return true;
    return this.runCore({
      hook: input.hook,
      kind: input.kind,
      runDir: input.runDir,
      name: input.name,
      backend: "shell",
      workspaceRoot: input.workspaceRoot,
      worktreePath: input.worktreePath,
      backendSessionId: "",
      stateId: `shell-${input.name}`,
      resuming: false,
      setupOutputFile: "",
    });
  }

  private async runCore(input: {
    hook: string;
    kind: "setup" | "cleanup";
    runDir: string;
    name: string;
    backend: AgentBackend | "shell";
    workspaceRoot: string;
    worktreePath: string;
    backendSessionId: string;
    stateId: string;
    resuming: boolean;
    setupOutputFile: string;
  }): Promise<boolean> {
    const logger = this.options.logger.child({
      sessionId: input.stateId,
      sessionName: input.name,
      hook: input.kind,
    });
    if (!existsSync(input.runDir)) {
      logger.warn("hook.skipped", {
        reason: "run_directory_missing",
        script: basename(input.hook),
        cwd: input.runDir,
      });
      return false;
    }
    const outputFile = `${this.outputFile(input.stateId, input.kind)}.${randomUUID()}`;
    const startedAt = Date.now();
    logger.info("hook.started", { script: basename(input.hook), cwd: input.runDir });
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
    if (input.kind === "cleanup" && input.setupOutputFile) args.push("--setup-output-file", input.setupOutputFile);
    const child = spawn(input.hook, args, {
      cwd: input.runDir,
      env: {
        ...this.options.environment,
        MUXIMO_NAME: input.name,
        MUXIMO_BACKEND: input.backend,
        MUXIMO_WORKSPACE: input.workspaceRoot,
        MUXIMO_WORKTREE: input.worktreePath,
        MUXIMO_SESSION_ID: input.backendSessionId,
        MUXIMO_STATE_ID: input.stateId,
        MUXIMO_HOOK_KIND: input.kind,
        MUXIMO_HOOK_SCRIPT: input.hook,
        MUXIMO_SETUP_OUTPUT_FILE: input.setupOutputFile,
      },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let spawnError: unknown;
    const output = createWriteStream(outputFile, { mode: 0o600 });
    child.stdout?.on("data", (chunk: Buffer) => {
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
    renameSync(outputFile, this.outputFile(input.stateId, input.kind));
    const success = exitCode === 0;
    const fields = {
      pid: child.pid,
      exitCode,
      success,
      durationMs: Date.now() - startedAt,
      ...(spawnError === undefined ? {} : errorFields(spawnError)),
    };
    if (success) logger.info("hook.finished", fields);
    else logger.warn("hook.finished", fields);
    return success;
  }

  private outputFile(stateId: string, kind: "setup" | "cleanup"): string {
    const directory = join(this.options.hookOutputRoot, stateId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, `${kind}.log`);
  }

  private removeEmptyDirectory(path: string): void {
    try {
      if (readdirSync(path).length === 0) rmdirSync(path);
    } catch {
      // A shared or already removed directory is harmless.
    }
  }
}
