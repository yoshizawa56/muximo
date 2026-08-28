import type { ManageSessionResult, RunShellInput, RunShellResult } from "@muximo/application";
import type { TmuxNewSessionResult } from "@muximo/infrastructure/cli-client";
import type {
  CliHandlers,
  CliIo,
  CliShellInput,
  CliTmuxManageSessionInput,
  CliTmuxNewSessionInput,
} from "../commands/types.js";
import { presentManagedSession, presentTmuxNewSession } from "../presenters/tmux.js";

type AsyncExecutor<Input, Result> = { execute(input: Input): Promise<Result> | Result };

export type InteractiveHandlerDependencies = {
  shell: AsyncExecutor<RunShellInput, RunShellResult>;
  tmux: AsyncExecutor<CliTmuxNewSessionInput, TmuxNewSessionResult>;
  manageSession: AsyncExecutor<CliTmuxManageSessionInput, ManageSessionResult>;
  io: CliIo;
};

export function createInteractiveHandlers(
  dependencies: InteractiveHandlerDependencies,
): Pick<CliHandlers, "shell" | "tmuxNewSession" | "tmuxManageSession"> {
  return {
    shell: async (input: CliShellInput) => (await dependencies.shell.execute(toRunShellInput(input))).process.code,
    tmuxNewSession: async (input) => presentTmuxNewSession(await dependencies.tmux.execute(input), dependencies.io),
    tmuxManageSession: async (input) =>
      presentManagedSession(await dependencies.manageSession.execute(input), dependencies.io),
  };
}

function toRunShellInput(input: CliShellInput): RunShellInput {
  return {
    shell: input.shell,
    command: input.command,
    exitAfterCommand: input.exitAfterCommand,
    worktree: input.worktree,
    worktreeName: input.worktreeName ?? undefined,
  };
}
