import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasNoError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { TmuxAdapter } from "../terminal/tmux.js";
import { type TmuxNewSessionResult, TmuxNewSessionService } from "./tmux-session.js";

type TmuxFixture = {
  root: string;
  tmux: RecordingTmux;
  service: TmuxNewSessionService;
};

type TmuxInput = { name: string; detached: boolean };

type TmuxContext = {
  createdName: string | undefined;
  managedSessionIdIsUuid: boolean;
  configuredManagedSessionIdMatches: boolean;
  attachmentState: TmuxNewSessionResult["attachment"]["state"] | undefined;
  events: readonly string[];
};

const cases = [
  {
    name: "creates a detached managed session without attaching",
    input: { name: "review", detached: true },
    assert: [
      hasNoError<TmuxContext, TmuxNewSessionResult>(),
      hasObserved<TmuxContext, TmuxNewSessionResult>("createdName", "review"),
      hasObserved<TmuxContext, TmuxNewSessionResult>("managedSessionIdIsUuid", true),
      hasObserved<TmuxContext, TmuxNewSessionResult>("configuredManagedSessionIdMatches", true),
      hasObserved<TmuxContext, TmuxNewSessionResult>("attachmentState", "detached"),
      hasObserved<TmuxContext, TmuxNewSessionResult>("events", [
        "has-session:review",
        "create:review",
        "session-option:default-command",
        "session-environment:MUXIMOD_MANAGED_SESSION_ID",
        "session-environment:MUXIMOD_MANAGED_SESSION_NAME",
        "metadata:managed_session_id",
        "metadata:managed",
        "metadata:wrapper",
      ]),
    ],
  },
  {
    name: "returns a deferred attach for an attached managed session",
    input: { name: "review", detached: false },
    assert: [
      hasNoError<TmuxContext, TmuxNewSessionResult>(),
      hasObserved<TmuxContext, TmuxNewSessionResult>("createdName", "review"),
      hasObserved<TmuxContext, TmuxNewSessionResult>("managedSessionIdIsUuid", true),
      hasObserved<TmuxContext, TmuxNewSessionResult>("configuredManagedSessionIdMatches", true),
      hasObserved<TmuxContext, TmuxNewSessionResult>("attachmentState", "attached"),
      hasObserved<TmuxContext, TmuxNewSessionResult>("events", [
        "has-session:review",
        "create:review",
        "session-option:default-command",
        "session-environment:MUXIMOD_MANAGED_SESSION_ID",
        "session-environment:MUXIMOD_MANAGED_SESSION_NAME",
        "metadata:managed_session_id",
        "metadata:managed",
        "metadata:wrapper",
      ]),
    ],
  },
  {
    name: "rejects a session name with unsupported characters",
    input: { name: "review/remote", detached: true },
    assert: [
      hasError<TmuxContext, TmuxNewSessionResult>({ message: "invalid session name 'review/remote'" }),
      hasObserved<TmuxContext, TmuxNewSessionResult>("events", []),
    ],
  },
  {
    name: "rejects a session name longer than the wire limit",
    input: { name: "a".repeat(65), detached: true },
    assert: [
      hasError<TmuxContext, TmuxNewSessionResult>({ message: `invalid session name '${"a".repeat(65)}'` }),
      hasObserved<TmuxContext, TmuxNewSessionResult>("events", []),
    ],
  },
] satisfies readonly OperationCase<"default", TmuxInput, TmuxNewSessionResult, TmuxContext>[];

const table: OperationTable<TmuxFixture, "default", TmuxInput, TmuxNewSessionResult, TmuxContext> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) => fixture.service.execute({ ...input, cwd: fixture.root }),
  observe: (fixture, outcome) => {
    const result = outcome.ok ? outcome.value : undefined;
    return {
      createdName: result?.created.name,
      managedSessionIdIsUuid: result ? /^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(result.created.managedSessionId) : false,
      configuredManagedSessionIdMatches:
        result !== undefined && fixture.tmux.configuredManagedSessionId === result.created.managedSessionId,
      attachmentState: result?.attachment.state,
      events: [...fixture.tmux.events],
    };
  },
};

function createFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: TmuxFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-tmux-session-"));
  const tmux = new RecordingTmux();
  const fixture = {
    root,
    tmux,
    service: new TmuxNewSessionService({
      environment: { MUXIMOD_MUXIMO_COMMAND: "/opt/muximo" },
      tmux,
    }),
  };
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  return { fixture };
}

class RecordingTmux extends TmuxAdapter {
  public readonly events: string[] = [];
  public configuredManagedSessionId: string | undefined;

  public constructor() {
    super("/tmp/muximo-tmux-session.sock");
  }

  public override hasSession(target: string): boolean {
    this.events.push(`has-session:${target}`);
    return false;
  }

  public override createSession(target: string, _cwd: string, _command?: string): void {
    this.events.push(`create:${target}`);
  }

  public override setSessionOption(_sessionName: string, name: string, _value: string): void {
    this.events.push(`session-option:${name}`);
  }

  public override setSessionEnvironment(_sessionName: string, name: string, value: string): void {
    if (name === "MUXIMOD_MANAGED_SESSION_ID") this.configuredManagedSessionId = value;
    this.events.push(`session-environment:${name}`);
  }

  public override setManagedSessionMetadata(
    _sessionName: string,
    field: Parameters<TmuxAdapter["setManagedSessionMetadata"]>[1],
    _value: string,
  ): void {
    this.events.push(`metadata:${field}`);
  }

  public override attachSession(target: string): number {
    this.events.push(`attach:${target}`);
    return 23;
  }
}

describe("tmux new session service", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
