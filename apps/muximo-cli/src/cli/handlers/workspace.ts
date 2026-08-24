import type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "@muximo/application";
import { clearPatch, type Patch, type WorkspaceRecord } from "@muximo/domain";
import type {
  CliHandlers,
  CliIo,
  CliWorkspaceAddInput,
  CliWorkspaceDeleteInput,
  CliWorkspaceListInput,
  CliWorkspaceUpdateInput,
} from "../commands/types.js";
import { displayWorkspacePath, presentWorkspaceList } from "../presenters/workspace.js";

type WorkspaceListService = { execute(): Promise<readonly WorkspaceRecord[]> };
type WorkspaceAddService = { execute(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> };
type WorkspaceUpdateService = {
  execute(selector: string, input: UpdateWorkspaceInput): Promise<WorkspaceRecord>;
};
type WorkspaceDeleteService = { execute(selector: string): Promise<WorkspaceRecord> };

export type WorkspaceHandlerDependencies = {
  list: WorkspaceListService;
  add: WorkspaceAddService;
  update: WorkspaceUpdateService;
  delete: WorkspaceDeleteService;
  io: CliIo;
};

export function createWorkspaceHandlers(
  dependencies: WorkspaceHandlerDependencies,
): Pick<CliHandlers, "workspaceList" | "workspaceAdd" | "workspaceUpdate" | "workspaceDelete"> {
  return {
    workspaceList: async (input: CliWorkspaceListInput) =>
      presentWorkspaceList(await dependencies.list.execute(), input.json, {
        write: (message) => dependencies.io.out.write(message),
        info: (message) => writeInfo(dependencies.io, message),
      }),
    workspaceAdd: async (input: CliWorkspaceAddInput) => {
      const workspace = await dependencies.add.execute(toAddInput(input));
      writeInfo(dependencies.io, `workspace '${workspace.name}' added (${displayWorkspacePath(workspace.rootPath)})`);
      return 0;
    },
    workspaceUpdate: async (input: CliWorkspaceUpdateInput) => {
      const workspace = await dependencies.update.execute(input.selector, toUpdateInput(input));
      writeInfo(dependencies.io, `workspace '${workspace.name}' updated`);
      return 0;
    },
    workspaceDelete: async (input: CliWorkspaceDeleteInput) => {
      const workspace = await dependencies.delete.execute(input.selector);
      writeInfo(dependencies.io, `workspace '${workspace.name}' unregistered; directory was not deleted`);
      return 0;
    },
  };
}

function toAddInput(input: CliWorkspaceAddInput): RegisterWorkspaceInput {
  return {
    directory: input.directory,
    name: input.nameExplicit ? input.name : undefined,
    setupHook: input.setupHookExplicit ? toWorkspacePatch(input.setupHook) : undefined,
    cleanupHook: input.cleanupHookExplicit ? toWorkspacePatch(input.cleanupHook) : undefined,
    worktreeCopyPatterns: input.copyPatternsExplicit ? input.copyPatterns : undefined,
  };
}

function toUpdateInput(input: CliWorkspaceUpdateInput): UpdateWorkspaceInput {
  return {
    name: input.nameExplicit ? input.name : undefined,
    setupHook: input.setupHookExplicit ? toWorkspacePatch(input.setupHook) : undefined,
    cleanupHook: input.cleanupHookExplicit ? toWorkspacePatch(input.cleanupHook) : undefined,
    worktreeCopyPatterns: input.copyPatternsExplicit ? input.copyPatterns : undefined,
    appendCopyPatterns: input.appendCopyPatterns,
    clearCopyPatterns: input.clearCopyPatterns,
  };
}

function toWorkspacePatch(value: string | null | undefined): Patch<string> {
  return value === null ? clearPatch : value;
}

function writeInfo(io: CliIo, message: string): void {
  io.out.write(`muximo: ${message}\n`);
}
