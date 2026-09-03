import type { TerminalHostSnapshot } from "@muximo/application";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, it } from "vitest";
import { mapTmuxSnapshotToTerminalHostSnapshot, TmuxMuximodHostAdapter } from "./muximod-host.js";
import { TmuxAdapter, type TmuxLiveSnapshot } from "./tmux.js";

type EmptyContext = {};
type MappingInput = { snapshot: TmuxLiveSnapshot };

const mappingCases = [
  {
    name: "maps a composite provider identity to neutral host identity",
    input: {
      snapshot: {
        available: true,
        tmuxServerId: "scope-1:server-1:started-at",
        tmuxServerScope: "scope-1",
        panes: [
          {
            paneId: "%1",
            tmuxServerId: "scope-1:server-1:started-at",
            windowId: "@1",
            sessionName: "muximod",
            windowName: "main",
            windowIndex: 0,
            paneIndex: 0,
            cwd: "/work/muximo",
            command: "zsh",
            title: "shell",
            active: true,
            left: 0,
            top: 0,
            width: 80,
            height: 24,
            windowWidth: 80,
            windowHeight: 24,
            muximodPaneId: "pane-1",
            muximodName: "shell",
            muximodKind: "shell",
            muximodAgentId: "",
            muximodWorkspaceId: "workspace-1",
            muximodManagedSessionId: "managed-1",
            muximodSessionId: "agent-session-1",
            muximodExecutionId: "execution-1",
          },
        ],
      },
    },
    assert: [
      returns<EmptyContext, TerminalHostSnapshot>({
        available: true,
        hostServerId: "scope-1:server-1:started-at",
        hostServerScope: "scope-1",
        panes: [
          {
            hostPaneId: "%1",
            hostServerId: "scope-1:server-1:started-at",
            windowId: "@1",
            sessionName: "muximod",
            windowName: "main",
            windowIndex: 0,
            paneIndex: 0,
            cwd: "/work/muximo",
            command: "zsh",
            title: "shell",
            active: true,
            left: 0,
            top: 0,
            width: 80,
            height: 24,
            windowWidth: 80,
            windowHeight: 24,
            muximodPaneId: "pane-1",
            muximodName: "shell",
            muximodKind: "shell",
            muximodAgentId: "",
            muximodWorkspaceId: "workspace-1",
            muximodManagedSessionId: "managed-1",
            muximodSessionId: "agent-session-1",
            muximodExecutionId: "execution-1",
          },
        ],
      }),
    ],
  },
  {
    name: "preserves an unavailable provider snapshot without inventing identity",
    input: {
      snapshot: { available: false, tmuxServerId: null, tmuxServerScope: null, panes: [] },
    },
    assert: [
      returns<EmptyContext, TerminalHostSnapshot>({
        available: false,
        hostServerId: null,
        hostServerScope: null,
        panes: [],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", MappingInput, TerminalHostSnapshot, EmptyContext>[];

const mappingTable: OperationTable<undefined, "default", MappingInput, TerminalHostSnapshot, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: mappingCases,
  execute: (_fixture, input) => mapTmuxSnapshotToTerminalHostSnapshot(input.snapshot),
  observe: () => ({}),
};

describe("tmux host adapter mappings", () => {
  runOperationTable(it as unknown as TestRegistrar, mappingTable);
});

type ManagementFixture = {
  adapter: RecordingManagementAdapter;
  host: TmuxMuximodHostAdapter;
};

type FindInput = {
  target: string;
  snapshot: TmuxLiveSnapshot;
};

const findCases = [
  {
    name: "finds the managed identity from the target session marker",
    input: { target: "desktop", snapshot: createSnapshot("desktop", "managed-1") },
    assert: [returns<EmptyContext, string | undefined>("managed-1")],
  },
  {
    name: "returns no identity for an unmanaged target session",
    input: { target: "desktop", snapshot: createSnapshot("desktop") },
    assert: [returns<EmptyContext, string | undefined>(undefined)],
  },
] satisfies readonly OperationCase<"default", FindInput, string | undefined, EmptyContext>[];

const findTable: OperationTable<ManagementFixture, "default", FindInput, string | undefined, EmptyContext> = {
  defaultFixture: createManagementFixture,
  cases: findCases,
  execute: (fixture, input) => {
    fixture.adapter.snapshot = input.snapshot;
    return fixture.host.findManagedSessionId(input.target);
  },
  observe: () => ({}),
};

type ConfigureInput = {
  target: string;
  managedSessionId: string;
};

const configureCases = [
  {
    name: "configures the default wrapper and stable session markers",
    input: { target: "desktop", managedSessionId: "managed-1" },
    assert: [
      returns<EmptyContext, string[][]>([
        ["set-option", "-t", "desktop", "default-command", "'/opt/muximo' shell"],
        ["set-environment", "-t", "desktop", "MUXIMOD_MANAGED_SESSION_ID", "managed-1"],
        ["set-environment", "-t", "desktop", "MUXIMOD_MANAGED_SESSION_NAME", "desktop"],
        ["set-option", "-t", "desktop", "@muximod.managed_session_id", "managed-1"],
        ["set-option", "-t", "desktop", "@muximod.managed", "1"],
        ["set-option", "-t", "desktop", "@muximod.wrapper", "muximo-shell"],
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", ConfigureInput, string[][], EmptyContext>[];

const configureTable: OperationTable<ManagementFixture, "default", ConfigureInput, string[][], EmptyContext> = {
  defaultFixture: createManagementFixture,
  cases: configureCases,
  execute: (fixture, input) =>
    Effect.gen(function* () {
      yield* fixture.host.configureManagedSession(input.target, input.managedSessionId);
      return fixture.adapter.commands;
    }),
  observe: () => ({}),
};

function createManagementFixture(): { fixture: ManagementFixture } {
  const adapter = new RecordingManagementAdapter();
  return {
    fixture: {
      adapter,
      host: new TmuxMuximodHostAdapter(adapter, { MUXIMOD_MUXIMO_COMMAND: "/opt/muximo" }),
    },
  };
}

function createSnapshot(sessionName: string, managedSessionId?: string): TmuxLiveSnapshot {
  return {
    available: true,
    tmuxServerId: "scope-1:server-1:started-at",
    tmuxServerScope: "scope-1",
    panes: [
      {
        paneId: "%1",
        tmuxServerId: "scope-1:server-1:started-at",
        windowId: "@1",
        sessionName,
        windowName: "main",
        windowIndex: 0,
        paneIndex: 0,
        cwd: "/work/muximo",
        command: "zsh",
        title: "shell",
        active: true,
        left: 0,
        top: 0,
        width: 80,
        height: 24,
        windowWidth: 80,
        windowHeight: 24,
        ...(managedSessionId ? { muximodManagedSessionId: managedSessionId } : {}),
      },
    ],
  };
}

class RecordingManagementAdapter extends TmuxAdapter {
  public commands: string[][] = [];
  public snapshot: TmuxLiveSnapshot = createSnapshot("desktop");

  public constructor() {
    super("/private/tmp/muximo-test.sock", undefined, { MUXIMO_WORKTREE_ID: "" });
  }

  public override listPanesSnapshot(): TmuxLiveSnapshot {
    return this.snapshot;
  }

  public override require(args: string[]): string {
    this.commands.push(args);
    return "";
  }
}

describe("tmux host session management", () => {
  runOperationTable(it as unknown as TestRegistrar, findTable);
  runOperationTable(it as unknown as TestRegistrar, configureTable);
});
