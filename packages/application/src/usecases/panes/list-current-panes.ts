import { Effect } from "effect";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export const listCurrentPanes = Effect.fn("Panes.listCurrent")(function* (sessionName?: string) {
  const panes = yield* reconcilePanes();
  return sessionName ? panes.filter((pane) => pane.sessionName === sessionName) : panes;
});
