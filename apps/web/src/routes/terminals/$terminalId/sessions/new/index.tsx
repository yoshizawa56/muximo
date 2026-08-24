import { createFileRoute } from "@tanstack/react-router";
import { NewSessionView } from "./-new-session-view";
import { useNewSessionViewModel } from "./-new-session-viewmodel";

export const Route = createFileRoute("/terminals/$terminalId/sessions/new/")({
  component: NewSessionRoute,
});

function NewSessionRoute() {
  return <NewSessionView viewModel={useNewSessionViewModel()} />;
}
