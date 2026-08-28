import { createFileRoute } from "@tanstack/react-router";
import { ControlRoomView } from "./-control-room/view";
import { useControlRoomViewModel } from "./-control-room/viewmodel";

export const Route = createFileRoute("/terminals/$terminalId/sessions/$sessionName/panes/$paneId/")({
  component: ControlRoomRoute,
});

function ControlRoomRoute() {
  const { paneId } = Route.useParams();
  return <ControlRoomView paneId={paneId} viewModel={useControlRoomViewModel()} />;
}
