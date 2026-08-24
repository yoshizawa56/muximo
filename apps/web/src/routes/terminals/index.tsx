import { createFileRoute, redirect } from "@tanstack/react-router";
import { readBrowserConnectionProfile } from "../../app/api/connection-profile-store";
import { TerminalsView } from "./-terminals-view";
import { useTerminalsViewModel } from "./-terminals-viewmodel";

export const Route = createFileRoute("/terminals/")({
  beforeLoad: () => {
    if (!readBrowserConnectionProfile()) throw redirect({ to: "/settings" });
  },
  component: TerminalsRoute,
});

function TerminalsRoute() {
  return <TerminalsView viewModel={useTerminalsViewModel()} />;
}
