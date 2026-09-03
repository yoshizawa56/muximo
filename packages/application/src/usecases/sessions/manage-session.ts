import { Effect } from "effect";
import { ApplicationError, type ManageSessionInput } from "../../ports/application.js";
import { MuximodSessionManagementService } from "../terminals/terminal-services.js";

/** Adopts an existing terminal-host session into muximo management. */
export const manageSession = Effect.fn("Sessions.manage")(function* (input: ManageSessionInput) {
  const host = yield* MuximodSessionManagementService;
  const name = input.name.trim();
  if (!name)
    return yield* Effect.fail(new ApplicationError("session_name_required", "A tmux session name is required"));
  if (!(yield* host.hasSession(name))) {
    return yield* Effect.fail(
      new ApplicationError("session_not_found", `terminal host session does not exist: ${name}`),
    );
  }

  if (yield* host.findManagedSessionId(name)) return { name, changed: false };

  yield* host.configureManagedSession(name, host.newId());
  return { name, changed: true };
});
