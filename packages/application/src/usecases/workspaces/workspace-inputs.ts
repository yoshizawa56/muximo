// Workspace CRUD operation inputs owned by the workspace use cases.
import type { Patch } from "@muximo/domain";

export type RegisterWorkspaceInput = {
  directory: string;
  name?: string;
  setupHook?: Patch<string>;
  cleanupHook?: Patch<string>;
};

export type UpdateWorkspaceInput = {
  name?: string;
  setupHook?: Patch<string>;
  cleanupHook?: Patch<string>;
};
