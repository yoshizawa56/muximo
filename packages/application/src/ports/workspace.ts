import type { WorkspaceId } from "@muximo/domain";

export type WorkspaceDirectoryInfo = {
  id: WorkspaceId;
  rootPath: string;
  name: string;
  isGit: boolean;
};
