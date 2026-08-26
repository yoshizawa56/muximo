import type { ManageSessionResult } from "@muximo/application";
import type { CliIo } from "../commands/types.js";

type TmuxNewSessionResult = {
  created: {
    name: string;
    managedSessionId: string;
  };
  attachment: { state: "detached" } | { state: "attached"; attach: () => number };
};

export function presentTmuxNewSession(result: TmuxNewSessionResult, io: CliIo): number {
  io.out.write(`muximo: created managed tmux session '${result.created.name}' (${result.created.managedSessionId})\n`);
  return result.attachment.state === "detached" ? 0 : result.attachment.attach();
}

export function presentManagedSession(result: ManageSessionResult, io: CliIo): number {
  io.out.write(
    result.changed
      ? `muximo: managed existing tmux session '${result.name}'\n`
      : `muximo: tmux session '${result.name}' is already managed\n`,
  );
  return 0;
}
