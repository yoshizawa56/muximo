import { createFileRoute } from "@tanstack/react-router";
import { NewPaneView } from "./-new-pane-view";
import { useNewPaneViewModel } from "./-new-pane-viewmodel";

export const Route = createFileRoute("/terminals/$terminalId/sessions/$sessionName/panes/new/")({
  component: NewPaneRoute,
});

function NewPaneRoute() {
  return <NewPaneView viewModel={useNewPaneViewModel()} />;
}
