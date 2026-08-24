import { AgentSession, type AgentSessionRecord } from "@muximo/domain";
import type {
  ManagedAgentSessionRepository,
  WorkspaceResolverPort,
  WorkspaceScope,
} from "../../ports/agent-sessions.js";

export type LocateAgentSessionInput = {
  reference: string;
  workspaceScope: WorkspaceScope;
};

export type LocateAgentSessionDependencies = {
  sessions: ManagedAgentSessionRepository;
  workspace: WorkspaceResolverPort;
};

/** Resolves a workspace/name reference without touching host APIs. */
export class LocateAgentSession {
  public constructor(private readonly deps: LocateAgentSessionDependencies) {}

  public async execute(input: LocateAgentSessionInput): Promise<AgentSessionRecord> {
    const separatorIndex = input.reference.indexOf("/");
    if (input.workspaceScope === "current" && separatorIndex >= 0) {
      throw new Error(`workspace-qualified session references require all-workspace scope: ${input.reference}`);
    }
    const selector = separatorIndex >= 0 ? input.reference.slice(0, separatorIndex) : undefined;
    const requestedName = separatorIndex >= 0 ? input.reference.slice(separatorIndex + 1) : input.reference;
    if (requestedName.includes("/")) throw new Error(`invalid session reference: ${input.reference}`);

    const sessions = await this.deps.sessions.list(
      input.workspaceScope === "all" ? undefined : (await this.deps.workspace.resolveCurrent()).id,
    );
    const scoped = sessions.filter(
      (session) => !selector || session.workspaceId === selector || session.workspaceName === selector,
    );
    const exactMatches = scoped.filter((session) => session.name === requestedName);
    const exactMatch = exactMatches[0];
    if (exactMatches.length === 1 && exactMatch) return exactMatch;
    if (exactMatches.length > 1) {
      throw new Error(
        `${input.workspaceScope === "all" ? "global " : ""}session name is ambiguous; use WORKSPACE/${requestedName}`,
      );
    }

    const normalizedName = normalizeSessionName(requestedName);
    const matches = scoped.filter((session) => session.name === normalizedName);
    if (matches.length === 0) {
      throw new Error(
        input.workspaceScope === "all"
          ? `global session not found: ${input.reference}`
          : `session not found in this workspace: ${input.reference}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `${input.workspaceScope === "all" ? "global " : ""}session name is ambiguous; use WORKSPACE/${normalizedName}`,
      );
    }
    const match = matches[0];
    if (!match) throw new Error(`session not found: ${input.reference}`);
    return match;
  }
}

function normalizeSessionName(value: string): string {
  try {
    return AgentSession.normalizeName(value);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}
