import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  resolveMuximoCommand,
  type TmuxAdapter,
} from "../terminal/tmux.js";
import { realpathSafe } from "./filesystem.js";

export type TmuxNewSessionInput = {
  name: string;
  cwd: string;
  detached: boolean;
};

export type TmuxNewSessionServiceOptions = {
  environment: NodeJS.ProcessEnv;
  tmux: TmuxAdapter;
};

export type TmuxNewSessionResult = {
  created: {
    name: string;
    managedSessionId: string;
  };
  attachment: { state: "detached" } | { state: "attached"; attach: () => number };
};

/** Narrow tmux session creation service used by the typed command handler. */
export class TmuxNewSessionService {
  public constructor(private readonly options: TmuxNewSessionServiceOptions) {}

  public execute(input: TmuxNewSessionInput): TmuxNewSessionResult {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\p{M}._-]{0,63}$/u.test(input.name)) {
      throw new Error(`invalid session name '${input.name}'`);
    }
    if (!existsSync(input.cwd)) throw new Error(`tmux session cwd does not exist: ${input.cwd}`);
    const normalized = { ...input, cwd: realpathSafe(input.cwd) };
    if (this.options.tmux.hasSession(normalized.name))
      throw new Error(`tmux session already exists: ${normalized.name}`);

    const managedSessionId = randomUUID();
    const binary = resolveMuximoCommand(this.options.environment);
    const firstPaneCommand = buildMuximoShellCommand(binary, {
      MUXIMOD_MANAGED_SESSION_ID: managedSessionId,
      MUXIMOD_MANAGED_SESSION_NAME: normalized.name,
    });
    let created = false;
    try {
      this.options.tmux.createSession(normalized.name, normalized.cwd, firstPaneCommand);
      created = true;
      configureManagedTmuxSession(this.options.tmux, normalized.name, managedSessionId, binary);
    } catch (error) {
      if (created) {
        try {
          this.options.tmux.killSession(normalized.name);
        } catch {
          // Preserve the original setup error.
        }
      }
      throw error;
    }
    return {
      created: { name: normalized.name, managedSessionId },
      attachment: normalized.detached
        ? { state: "detached" }
        : { state: "attached", attach: () => this.options.tmux.attachSession(normalized.name) },
    };
  }
}
