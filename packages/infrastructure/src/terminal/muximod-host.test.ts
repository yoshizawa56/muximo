import type { TerminalHostSnapshot } from "@muximo/application";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { mapTmuxSnapshotToTerminalHostSnapshot } from "./muximod-host.js";
import type { TmuxLiveSnapshot } from "./tmux.js";

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
