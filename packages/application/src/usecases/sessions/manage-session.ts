import { ApplicationError, type ManageSessionInput, type ManageSessionResult } from "../../ports/application.js";
import type { MuximodSessionManagementPort } from "../../ports/host.js";

/** Adopts an existing terminal-host session into muximo management. */
export async function manageSession(
  input: ManageSessionInput,
  host: MuximodSessionManagementPort,
): Promise<ManageSessionResult> {
  const name = input.name.trim();
  if (!name) throw new ApplicationError("session_name_required", "A tmux session name is required");
  if (!(await host.hasSession(name))) {
    throw new ApplicationError("session_not_found", `terminal host session does not exist: ${name}`);
  }

  if (await host.findManagedSessionId(name)) return { name, changed: false };

  await host.configureManagedSession(name, host.newId());
  return { name, changed: true };
}
