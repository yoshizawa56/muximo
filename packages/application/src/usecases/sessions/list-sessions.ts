import { Effect } from "effect";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { MuximodHostService } from "../terminals/terminal-services.js";
import { summarizeSessions } from "./summarize-sessions.js";

export const listSessions = Effect.fn("Sessions.list")(function* () {
  const host = yield* MuximodHostService;
  const snapshot = yield* host.listPanesSnapshot();
  const panes = yield* reconcilePanes(snapshot);
  const managedSessionNames = new Set(
    snapshot.panes.filter((pane) => pane.muximodManagedSessionId).map((pane) => pane.sessionName),
  );
  return summarizeSessions(panes, managedSessionNames);
});
