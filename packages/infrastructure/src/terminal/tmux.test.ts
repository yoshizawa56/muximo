// Tests for the terminal adapter stay co-located with its implementation.
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Assertion,
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { resolveMuximoCommand, TmuxAdapter, type TmuxClient, type TmuxLiveSnapshot, type TmuxPane } from "./tmux.js";

type EmptyContext = {};
type RecordingFixture = { adapter: RecordingTmuxAdapter };
const recordingFixture = (): FixtureHandle<RecordingFixture> => ({ fixture: { adapter: new RecordingTmuxAdapter() } });

type SplitInput = { keepZoomed: boolean };
const splitCases = [
  {
    name: "keeps a zoomed window zoomed while using the resolved target cwd",
    input: { keepZoomed: true },
    assert: [
      returns<EmptyContext, string[]>([
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-Z",
        "-h",
        "-t",
        "%1",
        "-c",
        "/tmp/project",
      ]),
    ],
  },
  {
    name: "does not zoom an ordinary desktop split and uses the resolved target cwd",
    input: { keepZoomed: false },
    assert: [
      returns<EmptyContext, string[]>([
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-h",
        "-t",
        "%1",
        "-c",
        "/tmp/project",
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", SplitInput, string[], EmptyContext>[];
const splitTable: OperationTable<RecordingFixture, "default", SplitInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: splitCases,
  execute: (fixture, input) => {
    fixture.adapter.splitWindow(undefined, "right", "%1", input.keepZoomed);
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

type NewWindowInput = { cwd?: string; command?: string };
const newWindowCases = [
  {
    name: "uses an explicit initial cwd for a new window",
    input: { cwd: "/tmp/project", command: "muximo shell" },
    assert: [
      returns<EmptyContext, string[]>([
        "new-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        "work",
        "-c",
        "/tmp/project",
        "muximo shell",
      ]),
    ],
  },
  {
    name: "lets tmux choose the inherited cwd when no initial cwd is given",
    input: {},
    assert: [returns<EmptyContext, string[]>(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "work"])],
  },
] satisfies readonly OperationCase<"default", NewWindowInput, string[], EmptyContext>[];
const newWindowTable: OperationTable<RecordingFixture, "default", NewWindowInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: newWindowCases,
  execute: (fixture, input) => {
    fixture.adapter.newWindow("work", input.cwd, input.command);
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

const switchCases = [
  {
    name: "keeps a zoomed window zoomed during client switch",
    input: { keepZoomed: true },
    assert: [returns<EmptyContext, string[]>(["switch-client", "-Z", "-c", "/dev/ttys016", "-t", "%1"])],
  },
  {
    name: "uses the ordinary client switch by default",
    input: { keepZoomed: false },
    assert: [returns<EmptyContext, string[]>(["switch-client", "-c", "/dev/ttys016", "-t", "%1"])],
  },
] satisfies readonly OperationCase<"default", SplitInput, string[], EmptyContext>[];
const switchTable: OperationTable<RecordingFixture, "default", SplitInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: switchCases,
  execute: (fixture, input) => {
    fixture.adapter.switchClient("/dev/ttys016", "%1", input.keepZoomed);
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

const createSessionCases = [
  {
    name: "passes a wrapper command when creating a session",
    input: {},
    assert: [
      returns<EmptyContext, string[]>(["new-session", "-d", "-s", "work", "-c", "/tmp/project", "muximo shell"]),
    ],
  },
] satisfies readonly OperationCase<"default", {}, string[], EmptyContext>[];
const createSessionTable: OperationTable<RecordingFixture, "default", {}, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: createSessionCases,
  execute: (fixture) => {
    fixture.adapter.createSession("work", "/tmp/project", "muximo shell");
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

const sessionOptionCases = [
  {
    name: "uses the session option for managed wrappers",
    input: {},
    assert: [returns<EmptyContext, string[]>(["set-option", "-t", "work", "default-command", "muximo shell"])],
  },
] satisfies readonly OperationCase<"default", {}, string[], EmptyContext>[];
const sessionOptionTable: OperationTable<RecordingFixture, "default", {}, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: sessionOptionCases,
  execute: (fixture) => {
    fixture.adapter.setSessionOption("work", "default-command", "muximo shell");
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

type GroupedSessionInput = { groupSession: string; sessionName: string };
const groupedSessionCases = [
  {
    name: "creates a detached session grouped with the exact source session",
    input: { groupSession: "work", sessionName: "muximo-mobile-1" },
    assert: [returns<EmptyContext, string[]>(["new-session", "-d", "-s", "muximo-mobile-1", "-t", "=work"])],
  },
] satisfies readonly OperationCase<"default", GroupedSessionInput, string[], EmptyContext>[];
const groupedSessionTable: OperationTable<RecordingFixture, "default", GroupedSessionInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: groupedSessionCases,
  execute: (fixture, input) => {
    fixture.adapter.createGroupedSession(input.groupSession, input.sessionName);
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

const sessionEnvironmentCases = [
  {
    name: "uses the session environment for managed wrappers",
    input: {},
    assert: [
      returns<EmptyContext, string[]>(["set-environment", "-t", "work", "MUXIMOD_MANAGED_SESSION_ID", "session-1"]),
    ],
  },
] satisfies readonly OperationCase<"default", {}, string[], EmptyContext>[];
const sessionEnvironmentTable: OperationTable<RecordingFixture, "default", {}, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: sessionEnvironmentCases,
  execute: (fixture) => {
    fixture.adapter.setSessionEnvironment("work", "MUXIMOD_MANAGED_SESSION_ID", "session-1");
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

type ResolveInput = { environment: NodeJS.ProcessEnv; runtime: { argv: string[]; execPath: string } };
const compiledEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/dev.mjs");
const sourceAgentEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/muximo-cli/src/index.ts");
const resolveCases = [
  {
    name: "uses the explicit launcher override",
    input: {
      environment: { MUXIMOD_MUXIMO_COMMAND: "/opt/muximo/muximo" },
      runtime: { argv: ["bun", "compiled"], execPath: "/opt/bun" },
    },
    assert: [returns<EmptyContext, string>("/opt/muximo/muximo")],
  },
  {
    name: "uses the current executable for a compiled launcher",
    input: { environment: {}, runtime: { argv: ["/opt/muximo/muximo", "tmux"], execPath: "/opt/muximo/muximo" } },
    assert: [returns<EmptyContext, string>("/opt/muximo/muximo")],
  },
  {
    name: "keeps a compiled JavaScript package launcher on the installed muximo binary",
    input: { environment: {}, runtime: { argv: ["/opt/node", compiledEntry], execPath: "/opt/node" } },
    assert: [returns<EmptyContext, string>("muximo")],
  },
  {
    name: "uses the current checkout source launcher",
    input: { environment: {}, runtime: { argv: ["/opt/bun", fileURLToPath(import.meta.url)], execPath: "/opt/bun" } },
    assert: [returns<EmptyContext, string>(sourceAgentEntry)],
  },
] satisfies readonly OperationCase<"default", ResolveInput, string, EmptyContext>[];
const resolveTable: OperationTable<undefined, "default", ResolveInput, string, EmptyContext> = {
  defaultFixture: () => ({ fixture: undefined }),
  cases: resolveCases,
  execute: (_fixture, input) => resolveMuximoCommand(input.environment, input.runtime),
  observe: () => ({}),
};

type RedrawInput = {};
type AttachInput = { target: string };
const attachCases = [
  {
    name: "attaches to the resolved pane target",
    input: { target: "%1" },
    assert: [
      returns<EmptyContext, string[]>([
        "-S",
        "/private/tmp/muximo-test.sock",
        "attach-session",
        "-f",
        "active-pane",
        "-t",
        "%1",
      ]),
    ],
  },
  {
    name: "attaches to a pane through the isolated mobile session",
    input: { target: "=muximo-mobile-1:@0.%1" },
    assert: [
      returns<EmptyContext, string[]>([
        "-S",
        "/private/tmp/muximo-test.sock",
        "attach-session",
        "-f",
        "active-pane",
        "-t",
        "=muximo-mobile-1:@0.%1",
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", AttachInput, string[], EmptyContext>[];
const attachTable: OperationTable<RecordingFixture, "default", AttachInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: attachCases,
  execute: (fixture, input) => fixture.adapter.attachArgs(input.target),
  observe: () => ({}),
};

const refreshCases = [
  {
    name: "fully redraws a client after viewport reconciliation",
    input: {},
    assert: [returns<EmptyContext, string[]>(["refresh-client", "-t", "/dev/ttys016"])],
  },
] satisfies readonly OperationCase<"default", RedrawInput, string[], EmptyContext>[];
const refreshTable: OperationTable<RecordingFixture, "default", RedrawInput, string[], EmptyContext> = {
  defaultFixture: recordingFixture,
  cases: refreshCases,
  execute: (fixture) => {
    fixture.adapter.refreshClient("/dev/ttys016");
    return fixture.adapter.lastArgs;
  },
  observe: () => ({}),
};

type ClientViewResult = { client: TmuxClient; args: string[] };
type ClientViewFixture = { adapter: ClientViewTmuxAdapter };
const clientViewCases = [
  {
    name: "targets the requested tmux client instead of the current pane",
    input: {},
    assert: [
      returns<EmptyContext, ClientViewResult>({
        client: {
          name: "/dev/ttys016",
          pid: 1234,
          tty: "/dev/ttys016",
          sessionName: "muximod",
          windowId: "@0",
          paneId: "%1",
          width: 120,
          height: 40,
          flags: "attached,focused",
          activity: 1,
        },
        args: [
          "display-message",
          "-p",
          "-c",
          "/dev/ttys016",
          "#{client_name}\t#{client_pid}\t#{client_tty}\t#{client_session}\t#{window_id}\t#{pane_id}\t#{client_width}\t#{client_height}\t#{client_flags}\t#{client_activity}",
        ],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, ClientViewResult, EmptyContext>[];
const clientViewTable: OperationTable<ClientViewFixture, "default", {}, ClientViewResult, EmptyContext> = {
  defaultFixture: () => ({ fixture: { adapter: new ClientViewTmuxAdapter() } }),
  cases: clientViewCases,
  execute: (fixture) => ({ client: fixture.adapter.clientView("/dev/ttys016"), args: fixture.adapter.lastArgs }),
  observe: () => ({}),
};

type ListResult = { panes: TmuxPane[]; args: string[] };
type ListContext = {};
const hasPaneListing: Assertion<ListContext, ListResult> = {
  name: "keeps the pane index separate from the server-wide pane id",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.panes).toMatchObject([{ paneId: "%32", windowIndex: 2, paneIndex: 4 }]);
    expect(result.value.args[3]).toContain("#{pane_index}");
  },
};
type ListKey = "control" | "octal";
const listCases = [
  {
    name: "keeps the pane index separate from the server-wide pane id",
    fixture: "control",
    input: {},
    assert: [hasPaneListing],
  },
  { name: "parses tmux's octal-escaped format separator", fixture: "octal", input: {}, assert: [hasPaneListing] },
] satisfies readonly OperationCase<ListKey, {}, ListResult, ListContext>[];
const listTable: OperationTable<{ adapter: ListingTmuxAdapter }, ListKey, {}, ListResult, ListContext> = {
  defaultFixture: () => ({ fixture: { adapter: new ListingTmuxAdapter("\u001f") } }),
  fixtures: {
    control: () => ({ fixture: { adapter: new ListingTmuxAdapter("\u001f") } }),
    octal: () => ({ fixture: { adapter: new ListingTmuxAdapter("\\037") } }),
  },
  cases: listCases,
  execute: (fixture) => ({ panes: fixture.adapter.listPanes(), args: fixture.adapter.lastArgs }),
  observe: () => ({}),
};

type SnapshotFixture = { adapter: SnapshotTmuxAdapter };
type SnapshotKey = "available" | "missing";
const snapshotFixtures: Readonly<Record<SnapshotKey, () => FixtureHandle<SnapshotFixture>>> = {
  available: () => ({
    fixture: {
      adapter: new SnapshotTmuxAdapter({
        status: 0,
        stdout: [
          "%1",
          "@0",
          "work",
          "shell",
          "0",
          "0",
          "/tmp",
          "zsh",
          "zsh",
          "1",
          "0",
          "0",
          "80",
          "24",
          "80",
          "24",
          "pane-1",
          "",
          "shell",
          "",
          "",
          "",
          "",
          "",
          "1234",
          "2026-08-14T12:00:00Z",
          "/private/tmp/muximo-test.sock",
        ].join("\u001f"),
        stderr: "",
      }),
    },
  }),
  missing: () => ({
    fixture: {
      adapter: new SnapshotTmuxAdapter({ status: 1, stdout: "", stderr: "no server running on /tmp/socket\n" }),
    },
  }),
};
const snapshotCases = [
  {
    name: "includes a server generation in the pane identity",
    fixture: "available",
    input: {},
    assert: [
      {
        name: "returns the server generation and scope",
        check: (_ctx: {}, result: { ok: true; value: TmuxLiveSnapshot } | { ok: false; error: unknown }) => {
          if (!result.ok) throw result.error;
          const scope = createHash("sha256").update("/private/tmp/muximo-test.sock").digest("hex").slice(0, 16);
          expect(result.value).toMatchObject({
            available: true,
            tmuxServerId: `${scope}:1234:2026-08-14T12:00:00Z`,
            tmuxServerScope: scope,
            panes: [{ paneId: "%1", tmuxServerId: `${scope}:1234:2026-08-14T12:00:00Z` }],
          });
        },
      },
    ],
  },
  {
    name: "marks a missing tmux server as unavailable",
    fixture: "missing",
    input: {},
    assert: [returns<{}, TmuxLiveSnapshot>({ panes: [], available: false, tmuxServerId: null, tmuxServerScope: null })],
  },
] satisfies readonly OperationCase<SnapshotKey, {}, TmuxLiveSnapshot, {}>[];
const snapshotTable: OperationTable<SnapshotFixture, SnapshotKey, {}, TmuxLiveSnapshot, {}> = {
  defaultFixture: snapshotFixtures.available,
  fixtures: snapshotFixtures,
  cases: snapshotCases,
  execute: (fixture) => fixture.adapter.listPanesSnapshot(),
  observe: () => ({}),
};

type MetadataFixture = { adapter: MetadataTmuxAdapter };
const metadataWriteCases = [
  {
    name: "writes execution identity before session identity",
    input: {},
    assert: [
      hasObserved<{ required: string[][] }, void>("required", [
        ["set-option", "-p", "-t", "%1", "@muximod.agent_execution_id", "execution-id-123456"],
        ["set-option", "-p", "-t", "%1", "@muximod.agent_session_id", "session-id"],
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", {}, void, { required: string[][] }>[];
const metadataWriteTable: OperationTable<MetadataFixture, "default", {}, void, { required: string[][] }> = {
  defaultFixture: () => ({ fixture: { adapter: new MetadataTmuxAdapter("new-execution-123456") } }),
  cases: metadataWriteCases,
  execute: (fixture) => {
    fixture.adapter.setAgentExecutionMetadata("%1", "session-id", "execution-id-123456");
  },
  observe: (fixture) => ({ required: [...fixture.adapter.required] }),
};
type ClearInput = { expectedExecutionId: string };
type ClearKey = "old" | "new";
const metadataClearCases = [
  {
    name: "does not clear metadata for a different execution",
    fixture: "old",
    input: { expectedExecutionId: "old-execution-123456" },
    assert: [
      returns<{ required: string[][] }, boolean>(false),
      hasObserved<{ required: string[][] }, boolean>("required", []),
    ],
  },
  {
    name: "clears metadata for the expected execution",
    fixture: "new",
    input: { expectedExecutionId: "new-execution-123456" },
    assert: [
      returns<{ required: string[][] }, boolean>(true),
      hasObserved<{ required: string[][] }, boolean>("required", [
        ["set-option", "-p", "-u", "-t", "%1", "@muximod.agent_execution_id"],
        ["set-option", "-p", "-u", "-t", "%1", "@muximod.agent_session_id"],
      ]),
    ],
  },
] satisfies readonly OperationCase<ClearKey, ClearInput, boolean, { required: string[][] }>[];
const metadataClearTable: OperationTable<MetadataFixture, ClearKey, ClearInput, boolean, { required: string[][] }> = {
  defaultFixture: () => ({ fixture: { adapter: new MetadataTmuxAdapter("new-execution-123456") } }),
  fixtures: {
    old: () => ({ fixture: { adapter: new MetadataTmuxAdapter("new-execution-123456") } }),
    new: () => ({ fixture: { adapter: new MetadataTmuxAdapter("new-execution-123456") } }),
  },
  cases: metadataClearCases,
  execute: (fixture, input) => fixture.adapter.clearAgentExecutionMetadata("%1", input.expectedExecutionId),
  observe: (fixture) => ({ required: [...fixture.adapter.required] }),
};

describe("tmux adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, splitTable);
  runOperationTable(register, newWindowTable);
  runOperationTable(register, switchTable);
  runOperationTable(register, createSessionTable);
  runOperationTable(register, sessionOptionTable);
  runOperationTable(register, groupedSessionTable);
  runOperationTable(register, sessionEnvironmentTable);
  runOperationTable(register, resolveTable);
  runOperationTable(register, attachTable);
  runOperationTable(register, refreshTable);
  runOperationTable(register, clientViewTable);
  runOperationTable(register, listTable);
  runOperationTable(register, snapshotTable);
  runOperationTable(register, metadataWriteTable);
  runOperationTable(register, metadataClearTable);
});

class RecordingTmuxAdapter extends TmuxAdapter {
  public lastArgs: string[] = [];
  public constructor() {
    super("/private/tmp/muximo-test.sock");
  }
  public override require(args: string[]): string {
    this.lastArgs = args;
    return "/tmp/project\n";
  }
  public override command(args: string[]) {
    this.lastArgs = args;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class ClientViewTmuxAdapter extends TmuxAdapter {
  public lastArgs: string[] = [];
  public constructor() {
    super("/private/tmp/muximo-test.sock");
  }
  public override require(args: string[]): string {
    this.lastArgs = args;
    return (
      ["/dev/ttys016", "1234", "/dev/ttys016", "muximod", "@0", "%1", "120", "40", "attached,focused", "1"].join("\t") +
      "\n"
    );
  }
}

class ListingTmuxAdapter extends TmuxAdapter {
  public lastArgs: string[] = [];
  public constructor(private readonly separator = "\u001f") {
    super("/private/tmp/muximo-test.sock");
  }
  public override command(args: string[]) {
    this.lastArgs = args;
    return {
      status: 0,
      stdout: `${[
        "%32",
        "@5",
        "muximod",
        "code",
        "2",
        "4",
        "/tmp",
        "zsh",
        "zsh",
        "1",
        "0",
        "0",
        "80",
        "24",
        "120",
        "40",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "1234",
        "2026-08-14T12:00:00Z",
        "/private/tmp/muximo-test.sock",
      ].join(this.separator)}\n`,
      stderr: "",
    };
  }
}

class SnapshotTmuxAdapter extends TmuxAdapter {
  public constructor(private readonly result: { status: number; stdout: string; stderr: string }) {
    super("/private/tmp/muximo-test.sock");
  }
  public override command(_args: string[]): { status: number; stdout: string; stderr: string } {
    return this.result;
  }
}

class MetadataTmuxAdapter extends TmuxAdapter {
  public required: string[][] = [];
  public constructor(private readonly executionId: string) {
    super("/private/tmp/muximo-test.sock");
  }
  public override command(args: string[]) {
    if (args[0] === "show-options") return { status: 0, stdout: `${this.executionId}\n`, stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  }
  public override require(args: string[]): string {
    this.required.push(args);
    return "";
  }
}
