import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesListView } from "./-workspaces-view";
import { useWorkspacesListViewModel } from "./-workspaces-viewmodel";

export const Route = createFileRoute("/workspaces/")({
  component: WorkspacesRoute,
});

function WorkspacesRoute() {
  return <WorkspacesListView viewModel={useWorkspacesListViewModel()} />;
}
