import type { ApplicationEffect, ProcessResult, ShellProcessInput, ShellProcessPort } from "@muximo/application";
import { resolveExecutable } from "../agents/launch.js";
import { fromPromise } from "../effect.js";
import { spawnAttached } from "../process/process.js";

export type ShellProcessAdapterOptions = {
  environment: NodeJS.ProcessEnv;
};

/** Resolves and runs one attached shell process; it owns no shell workflow. */
export class ShellProcessAdapter implements ShellProcessPort {
  public constructor(private readonly options: ShellProcessAdapterOptions) {}

  public run(input: ShellProcessInput): ApplicationEffect<ProcessResult> {
    return fromPromise(() => {
      const executable = resolveExecutable(input.executable, this.options.environment);
      const environment: NodeJS.ProcessEnv = {
        ...this.options.environment,
        MUXIMOD_WRAPPED_SHELL: "1",
      };
      if (input.interactive) delete environment.MUXIMOD_WORKTREE_SESSION_NAME;
      return spawnAttached(executable, [...input.args], input.cwd, environment);
    });
  }
}
