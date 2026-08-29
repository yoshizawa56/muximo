import type { Writable } from "node:stream";
import type { AgentBackend } from "@muximo/domain";
import type { MuximoCliRuntimeOptions } from "../runtime-types.js";

export type CliIo = {
  out: Writable;
  err: Writable;
};

export type CliRunInput = {
  backend: AgentBackend;
  name?: string;
  useWorktree: boolean;
  worktreeRoot?: string;
  setupHook?: string;
  cleanupHook?: string;
  setupHookExplicit: boolean;
  cleanupHookExplicit: boolean;
  backendArgs: readonly string[];
};

export type CliShellInput = {
  shell?: string;
  command: readonly string[];
  exitAfterCommand: boolean;
  worktree: boolean;
  worktreeName: string | null;
};

export type CliTmuxNewSessionInput = {
  name: string;
  cwd: string;
  detached: boolean;
};

export type CliTmuxManageSessionInput = {
  name: string;
};

export type CliSessionListInput = {
  global: boolean;
  names: boolean;
  json: boolean;
  all: boolean;
};

export type CliSessionResumeInput = {
  global: boolean;
  reference: string;
  backendArgs: readonly string[];
};

export type CliSessionCleanupInput = {
  global: boolean;
  force: boolean;
  reference: string;
};

export type CliDoctorInput = {
  verbose: boolean;
};

export type CliDaemonInput = {
  command: "start" | "status" | "stop" | "restart" | "ensure" | "log";
  foreground: boolean;
  refreshServers: boolean;
  lines?: number;
};

export type CliPairInput = {
  withoutServe: boolean;
  muximodBaseUrl?: string;
  display: "browser" | "terminal";
};

export type CliServeInput = {
  provider: "tailscale";
  command: "tailscale" | "status" | "stop";
  localPort: number;
  externalPort: number;
  path?: string;
};

export type CliWorkspaceListInput = {
  json: boolean;
};

export type CliWorkspaceMutationInput = {
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

export type CliWorkspaceAddInput = CliWorkspaceMutationInput & {
  directory: string;
};

export type CliWorkspaceUpdateInput = CliWorkspaceMutationInput & {
  selector: string;
};

export type CliWorkspaceDeleteInput = {
  selector: string;
};

export type CliHandlers = {
  run(input: CliRunInput): Promise<number>;
  shell(input: CliShellInput): Promise<number>;
  tmuxNewSession(input: CliTmuxNewSessionInput): Promise<number>;
  tmuxManageSession(input: CliTmuxManageSessionInput): Promise<number>;
  sessionList(input: CliSessionListInput): Promise<number>;
  sessionResume(input: CliSessionResumeInput): Promise<number>;
  sessionCleanup(input: CliSessionCleanupInput): Promise<number>;
  doctor(input: CliDoctorInput): Promise<number>;
  daemon(input: CliDaemonInput): Promise<number>;
  pair(input: CliPairInput): Promise<number>;
  serve(input: CliServeInput): Promise<number>;
  workspaceList(input: CliWorkspaceListInput): Promise<number>;
  workspaceAdd(input: CliWorkspaceAddInput): Promise<number>;
  workspaceUpdate(input: CliWorkspaceUpdateInput): Promise<number>;
  workspaceDelete(input: CliWorkspaceDeleteInput): Promise<number>;
};

export type CliAppDeps = {
  io: CliIo;
  handlers: CliHandlers;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  runtime?: MuximoCliRuntimeOptions;
  rootCommand?: string;
  lifecycle?: CliCommandLifecycle;
};

export type CliCommandLifecycle = {
  started(commandPath: readonly string[]): void;
  finished(commandPath: readonly string[], status: number): void;
};

export type CliCommandContext = {
  io: CliIo;
  cwd: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  runtime?: MuximoCliRuntimeOptions;
  rootCommand: string;
  report(status: number): void;
  lifecycle?: CliCommandLifecycle;
};
