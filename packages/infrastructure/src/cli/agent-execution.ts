import type { AgentExecutionResult, AgentExecutionSpec } from "@muximo/application";
import { spawnAttached } from "../process/process.js";

export type AttachedAgentExecutionLogger = {
  debug(event: string, fields?: Record<string, unknown>): void;
};

export type AttachedAgentExecutionOptions = {
  onStarted?: (pid: number, startedAt: string) => void | Promise<void>;
};

/** Runs one prepared agent command with the CLI process's inherited stdio. */
export class AttachedAgentExecutionAdapter {
  public constructor(private readonly logger?: AttachedAgentExecutionLogger) {}

  public execute(
    input: AgentExecutionSpec,
    options: AttachedAgentExecutionOptions = {},
  ): Promise<AgentExecutionResult> {
    const executable = input.command[0];
    if (!executable) throw new Error("agent execution command executable is missing");
    // Keep all standard streams inherited for interactive providers. Capturing
    // stderr would replace the child's stderr TTY with a pipe and can make the
    // provider reject the launch, so failure diagnostics remain on the TTY.
    return spawnAttached(executable, [...input.command.slice(1)], input.cwd, input.environment, {
      captureFailureDiagnostic: false,
      onStarted: async (pid, startedAt) => {
        if (pid === undefined) return;
        this.logger?.debug("agent.process_started", { backend: input.backend, pid, startedAt });
        await options.onStarted?.(pid, startedAt);
      },
      onError: (error) => this.logger?.debug("agent.process_spawn_failed", { backend: input.backend, error }),
    });
  }
}
