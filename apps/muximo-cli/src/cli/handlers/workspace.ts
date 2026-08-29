import type { RegisterWorkspaceRequest, UpdateWorkspaceRequest, WorkspaceDirectory } from "@muximo/contract/api";
import type {
  CliHandlers,
  CliIo,
  CliWorkspaceAddInput,
  CliWorkspaceDeleteInput,
  CliWorkspaceListInput,
  CliWorkspaceUpdateInput,
} from "../commands/types.js";
import { displayWorkspacePath, presentWorkspaceList } from "../presenters/workspace.js";

type WorkspaceListService = { execute(): Promise<readonly WorkspaceDirectory[]> };
type WorkspaceAddService = { execute(input: RegisterWorkspaceRequest): Promise<WorkspaceDirectory> };
type WorkspaceUpdateService = {
  execute(selector: string, input: UpdateWorkspaceRequest): Promise<WorkspaceDirectory>;
};
type WorkspaceDeleteService = { execute(selector: string): Promise<WorkspaceDirectory> };

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
      writeInfo(dependencies.io, `workspace '${workspace.name}' added (${displayWorkspacePath(workspace.directory)})`);
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

function toAddInput(input: CliWorkspaceAddInput): RegisterWorkspaceRequest {
  return {
    directory: input.directory,
    ...(input.nameExplicit && input.name !== undefined ? { name: input.name } : {}),
    ...(input.setupHookExplicit ? { setupScriptPath: input.setupHook } : {}),
    ...(input.cleanupHookExplicit ? { cleanupScriptPath: input.cleanupHook } : {}),
  };
}

function toUpdateInput(input: CliWorkspaceUpdateInput): UpdateWorkspaceRequest {
  return {
    ...(input.nameExplicit && input.name !== undefined ? { name: input.name } : {}),
    ...(input.setupHookExplicit ? { setupScriptPath: input.setupHook } : {}),
    ...(input.cleanupHookExplicit ? { cleanupScriptPath: input.cleanupHook } : {}),
  };
}

function writeInfo(io: CliIo, message: string): void {
  io.out.write(`[muximo-cli] ${message}\n`);
}
