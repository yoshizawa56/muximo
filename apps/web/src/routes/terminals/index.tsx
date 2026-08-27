import { createFileRoute, redirect } from "@tanstack/react-router";
import { readBrowserConnectionProfiles } from "../../app/api/connection-profile-store";
import { TerminalsView } from "./-terminals-view";
import { useTerminalsViewModel } from "./-terminals-viewmodel";

export const Route = createFileRoute("/terminals/")({
  beforeLoad: ({ search }) => {
    const profiles = readBrowserConnectionProfiles();
    if (profiles.length === 0) throw redirect({ to: "/settings", search: { connection: undefined } });
    if (search.connection && !profiles.some((profile) => profile.id === search.connection)) {
      throw redirect({ to: "/settings", search: { connection: undefined } });
    }
    if (!search.connection) {
      throw redirect({ to: "/terminals", search: { connection: profiles[0].id } });
    }
  },
  component: TerminalsRoute,
});

function TerminalsRoute() {
  return <TerminalsView viewModel={useTerminalsViewModel()} />;
}
