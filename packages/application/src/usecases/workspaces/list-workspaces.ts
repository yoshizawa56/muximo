import { Effect } from "effect";
import { WorkspaceRepositoryService } from "./workspace-services.js";

export const listWorkspaces = Effect.fn("Workspaces.list")(function* () {
  const workspaces = yield* WorkspaceRepositoryService;
  return yield* workspaces.list();
});
