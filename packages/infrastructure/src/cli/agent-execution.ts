import type { AgentExecutionPort } from "@muximo/application";
import { spawnAttached } from "../process/process.js";

export type AttachedAgentExecutionLogger = {
  debug(event: string, fields?: Record<string, unknown>): void;
};

/** Runs one prepared agent command with the CLI process's inherited stdio. */
export class AttachedAgentExecutionAdapter implements AgentExecutionPort {
  public readonly ownerPid = process.pid;

  public constructor(private readonly logger?: AttachedAgentExecutionLogger) {}

  public execute(input: Parameters<AgentExecutionPort["execute"]>[0]) {
    const executable = input.command[0];
    if (!executable) throw new Error("agent execution command executable is missing");
    return spawnAttached(executable, [...input.command.slice(1)], input.cwd, input.environment, {
      signal: input.signal,
      onStarted: (pid) => this.logger?.debug("agent.process_started", { backend: input.backend, pid }),
      onError: (error) => this.logger?.debug("agent.process_spawn_failed", { backend: input.backend, error }),
    });
  }
}
