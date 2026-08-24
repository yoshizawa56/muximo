import type {
  AgentSessionListInput,
  AgentSessionListResult,
  CleanupAgentSessionInput,
  CleanupAgentSessionResult,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  RunAgentSessionResult,
  StartAgentSessionInput,
} from "@muximo/application";
import type {
  CliHandlers,
  CliIo,
  CliRunInput,
  CliSessionCleanupInput,
  CliSessionResumeInput,
} from "../commands/types.js";
import {
  presentCleanupAgentSession,
  presentResumeAgentSession,
  presentRunAgentSession,
} from "../presenters/session.js";
import { presentCliSessionList } from "../presenters/session-list.js";

type AsyncExecutor<Input, Result> = {
  execute(input: Input): Promise<Result>;
};

export type SessionHandlerDependencies = {
  run: AsyncExecutor<StartAgentSessionInput, RunAgentSessionResult>;
  resume: AsyncExecutor<ResumeAgentSessionInput, ResumeAgentSessionResult>;
  cleanup: AsyncExecutor<CleanupAgentSessionInput, CleanupAgentSessionResult>;
  list: AsyncExecutor<AgentSessionListInput, AgentSessionListResult>;
  io: CliIo;
};

export function createSessionHandlers(
  dependencies: SessionHandlerDependencies,
): Pick<CliHandlers, "run" | "sessionList" | "sessionResume" | "sessionCleanup"> {
  return {
    run: async (input: CliRunInput) =>
      presentRunAgentSession(await dependencies.run.execute(toStartInput(input)), dependencies.io),
    sessionResume: async (input: CliSessionResumeInput) =>
      presentResumeAgentSession(await dependencies.resume.execute(toResumeInput(input)), dependencies.io),
    sessionCleanup: async (input: CliSessionCleanupInput) =>
      presentCleanupAgentSession(await dependencies.cleanup.execute(toCleanupInput(input)), dependencies.io),
    sessionList: async (input) =>
      presentCliSessionList(
        { names: input.names, json: input.json, showWorkspace: input.global },
        await dependencies.list.execute({
          workspaceScope: input.global ? "all" : "current",
          includeUnavailable: input.all,
        }),
        {
          write: (message) => dependencies.io.out.write(message),
          info: (message) => writeInfo(dependencies.io, message),
        },
      ),
  };
}

function toStartInput(input: CliRunInput): StartAgentSessionInput {
  return input;
}

function toResumeInput(input: CliSessionResumeInput): ResumeAgentSessionInput {
  return {
    workspaceScope: input.global ? "all" : "current",
    reference: input.reference,
    backendArgs: input.backendArgs,
  };
}

function toCleanupInput(input: CliSessionCleanupInput): CleanupAgentSessionInput {
  return {
    workspaceScope: input.global ? "all" : "current",
    force: input.force,
    reference: input.reference,
  };
}

function writeInfo(io: CliIo, message: string): void {
  io.out.write(`muximo: ${message}\n`);
}
