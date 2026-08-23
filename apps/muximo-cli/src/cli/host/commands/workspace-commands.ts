import type {
  DeleteWorkspace,
  ListWorkspaces,
  RegisterWorkspace,
  UpdateWorkspace,
  UpdateWorkspaceInput,
} from "@muximo/application";
import {
  displayWorkspacePath,
  MuximoCommandError,
  padHeader,
  padRow,
  requireOptionValue,
  toWorkspaceJson,
  toWorkspacePatch,
  workspaceAddUsage,
  workspaceUpdateUsage,
} from "../command-support.js";

export type WorkspaceListOptions = {
  json: boolean;
};

export type WorkspaceMutationOptions = {
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

export type WorkspaceDeleteOptions = {
  selector: string;
};

export type WorkspaceCommandDeps = {
  write(text: string): void;
  info(message: string): void;
  workspaceList: ListWorkspaces;
  workspaceRegister: RegisterWorkspace;
  workspaceUpdate: UpdateWorkspace;
  workspaceDelete: DeleteWorkspace;
};

export function parseWorkspaceListOptions(args: string[]): WorkspaceListOptions {
  let json = false;
  for (const argument of args) {
    if (argument === "--json") json = true;
    else throw new MuximoCommandError(`unknown workspace list option: ${argument}`);
  }
  return { json };
}

export function parseWorkspaceMutationOptions(args: string[], mode: "add" | "update"): WorkspaceMutationOptions {
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
      if (mode === "update")
        throw new MuximoCommandError("workspace directory is immutable; delete and add a new registration");
      directory = requireOptionValue(argument, args[++index]);
    } else if (argument.startsWith("--directory=") || argument.startsWith("--path=")) {
      if (mode === "update")
        throw new MuximoCommandError("workspace directory is immutable; delete and add a new registration");
      const option = argument.startsWith("--directory=") ? "--directory" : "--path";
      directory = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
    } else if (argument === "--setup-hook" || argument === "--setup-script" || argument === "--setup-script-path") {
      setupHook = requireOptionValue(argument, args[++index]);
      setupHookExplicit = true;
    } else if (
      argument.startsWith("--setup-hook=") ||
      argument.startsWith("--setup-script=") ||
      argument.startsWith("--setup-script-path=")
    ) {
      const option = argument.startsWith("--setup-hook=")
        ? "--setup-hook"
        : argument.startsWith("--setup-script=")
          ? "--setup-script"
          : "--setup-script-path";
      setupHook = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
      setupHookExplicit = true;
    } else if (argument === "--no-setup-hook" || argument === "--no-setup-script") {
      setupHook = null;
      setupHookExplicit = true;
    } else if (
      argument === "--cleanup-hook" ||
      argument === "--cleanup-script" ||
      argument === "--cleanup-script-path"
    ) {
      cleanupHook = requireOptionValue(argument, args[++index]);
      cleanupHookExplicit = true;
    } else if (
      argument.startsWith("--cleanup-hook=") ||
      argument.startsWith("--cleanup-script=") ||
      argument.startsWith("--cleanup-script-path=")
    ) {
      const option = argument.startsWith("--cleanup-hook=")
        ? "--cleanup-hook"
        : argument.startsWith("--cleanup-script=")
          ? "--cleanup-script"
          : "--cleanup-script-path";
      cleanupHook = requireOptionValue(option, argument.slice(argument.indexOf("=") + 1));
      cleanupHookExplicit = true;
    } else if (argument === "--no-cleanup-hook" || argument === "--no-cleanup-script") {
      cleanupHook = null;
      cleanupHookExplicit = true;
    } else if (argument === "--copy-pattern" || argument === "--worktree-copy-pattern" || argument === "--copy") {
      copyPatterns.push(requireOptionValue(argument, args[++index]));
      copyPatternsExplicit = true;
    } else if (
      argument.startsWith("--copy-pattern=") ||
      argument.startsWith("--worktree-copy-pattern=") ||
      argument.startsWith("--copy=")
    ) {
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
      throw new MuximoCommandError(
        `workspace ${mode} accepts exactly one ${mode === "add" ? "directory" : "workspace selector"}`,
      );
    }
  }

  if (mode === "add" && !directory) throw new MuximoCommandError("workspace add requires a directory");
  if (mode === "update" && !selector) throw new MuximoCommandError("workspace update requires a workspace selector");
  if (mode === "add" && (appendCopyPatterns.length > 0 || clearCopyPatterns)) {
    throw new MuximoCommandError("--add-copy-pattern and --clear-copy-patterns are only valid for workspace update");
  }
  if (copyPatternsExplicit && clearCopyPatterns)
    throw new MuximoCommandError("--clear-copy-patterns cannot be combined with --copy-pattern");
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

export function parseWorkspaceDeleteOptions(args: string[]): WorkspaceDeleteOptions {
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

export async function listWorkspaces(deps: WorkspaceCommandDeps, options: WorkspaceListOptions): Promise<number> {
  const workspaces = await runWorkspaceUseCase(() => deps.workspaceList.execute());
  if (options.json) {
    for (const workspace of workspaces) deps.write(`${JSON.stringify(toWorkspaceJson(workspace))}\n`);
    return 0;
  }

  deps.write(padHeader(["ID", "NAME", "DIRECTORY", "GIT", "SETUP_HOOK", "CLEANUP_HOOK", "COPY_PATTERNS"]));
  if (workspaces.length === 0) {
    deps.info("no registered workspaces");
    return 0;
  }
  for (const workspace of workspaces) {
    deps.write(
      padRow([
        workspace.id,
        workspace.name,
        displayWorkspacePath(workspace.rootPath),
        workspace.isGit ? "yes" : "no",
        workspace.setupScriptPath ? displayWorkspacePath(workspace.setupScriptPath) : "-",
        workspace.cleanupScriptPath ? displayWorkspacePath(workspace.cleanupScriptPath) : "-",
        workspace.worktreeCopyPatterns.length > 0 ? workspace.worktreeCopyPatterns.join(",") : "-",
      ]),
    );
  }
  return 0;
}

export async function addWorkspace(deps: WorkspaceCommandDeps, options: WorkspaceMutationOptions): Promise<number> {
  const workspace = await runWorkspaceUseCase(() =>
    deps.workspaceRegister.execute({
      directory: options.directory!,
      name: options.nameExplicit ? options.name : undefined,
      setupHook: options.setupHookExplicit ? toWorkspacePatch(options.setupHook) : undefined,
      cleanupHook: options.cleanupHookExplicit ? toWorkspacePatch(options.cleanupHook) : undefined,
      worktreeCopyPatterns: options.copyPatternsExplicit ? options.copyPatterns : undefined,
    }),
  );
  deps.info(`workspace '${workspace.name}' added (${displayWorkspacePath(workspace.rootPath)})`);
  return 0;
}

export async function updateWorkspace(deps: WorkspaceCommandDeps, options: WorkspaceMutationOptions): Promise<number> {
  const input: UpdateWorkspaceInput = {
    name: options.nameExplicit ? options.name : undefined,
    setupHook: options.setupHookExplicit ? toWorkspacePatch(options.setupHook) : undefined,
    cleanupHook: options.cleanupHookExplicit ? toWorkspacePatch(options.cleanupHook) : undefined,
    worktreeCopyPatterns: options.copyPatternsExplicit ? options.copyPatterns : undefined,
    appendCopyPatterns: options.appendCopyPatterns,
    clearCopyPatterns: options.clearCopyPatterns,
  };
  const workspace = await runWorkspaceUseCase(() => deps.workspaceUpdate.execute(options.selector!, input));
  deps.info(`workspace '${workspace.name}' updated`);
  return 0;
}

export async function deleteWorkspace(deps: WorkspaceCommandDeps, options: WorkspaceDeleteOptions): Promise<number> {
  const workspace = await runWorkspaceUseCase(() => deps.workspaceDelete.execute(options.selector));
  deps.info(`workspace '${workspace.name}' unregistered; directory was not deleted`);
  return 0;
}

export async function runWorkspaceUseCase<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MuximoCommandError) throw error;
    throw new MuximoCommandError(error instanceof Error ? error.message : String(error));
  }
}

/** Runs one `muximo workspace <subcommand>` invocation against injected use cases. */
export async function executeWorkspaceCommand(args: string[], deps: WorkspaceCommandDeps): Promise<number> {
  const [subcommand = "", ...rest] = args;
  if (subcommand === "" || subcommand === "-h" || subcommand === "--help") {
    deps.write("Usage: muximo workspace <list|add|register|update|delete> [OPTIONS]\n");
    return subcommand === "" ? 2 : 0;
  }
  switch (subcommand) {
    case "list":
      if (rest.includes("-h") || rest.includes("--help")) {
        deps.write("Usage: muximo workspace list [--json]\n");
        return 0;
      }
      return listWorkspaces(deps, parseWorkspaceListOptions(rest));
    case "add":
    case "register":
      if (rest.includes("-h") || rest.includes("--help")) {
        deps.write(workspaceAddUsage(subcommand));
        return 0;
      }
      return addWorkspace(deps, parseWorkspaceMutationOptions(rest, "add"));
    case "update":
      if (rest.includes("-h") || rest.includes("--help")) {
        deps.write(workspaceUpdateUsage());
        return 0;
      }
      return updateWorkspace(deps, parseWorkspaceMutationOptions(rest, "update"));
    case "delete":
    case "remove":
    case "rm":
      if (rest.includes("-h") || rest.includes("--help")) {
        deps.write("Usage: muximo workspace delete WORKSPACE [--force]\n");
        return 0;
      }
      return deleteWorkspace(deps, parseWorkspaceDeleteOptions(rest));
    default:
      throw new MuximoCommandError(`unknown workspace command: ${subcommand}`);
  }
}
