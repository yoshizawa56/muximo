import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceDetailView } from "./-workspace-detail-view";
import { useWorkspaceDetailViewModel } from "./-workspace-detail-viewmodel";

export const Route = createFileRoute("/workspaces/$workspaceId/")({
  component: WorkspaceDetailRoute,
});

function WorkspaceDetailRoute() {
  const params = Route.useParams() as { workspaceId: string };
  return <WorkspaceDetailView viewModel={useWorkspaceDetailViewModel(params.workspaceId)} />;
}
