import { describe, it } from "vitest";
import {
  hasError,
  hasNoError,
  hasObserved,
  returns,
  runScenarioTable,
  type FixtureHandle,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { ListPanes } from "./list-panes.js";
import { ResizePane } from "./resize-pane.js";
import { SendPaneInput } from "./send-pane-input.js";
import type { PaneGateway } from "../../ports/panes.js";
import type { PaneRepository } from "../../ports/repositories.js";
import { Pane, PaneId } from "@muximo/domain";
import type { PaneRecord } from "@muximo/domain";

const pane: PaneRecord = Pane.create({
  id: PaneId.create("pane-1"),
  tmuxPaneId: "%1",
  sessionName: "muximod",
  windowId: "@0",
  kind: "shell",
  name: "shell",
  cwd: "/tmp",
  workspaceId: undefined,
  agentId: undefined,
  state: "running",
  title: undefined,
  lastSeenAt: "2026-08-09T00:00:00.000Z",
});

class FakePanes implements PaneRepository {
  public records = [pane];
  public async list() { return this.records; }
  public async findById(id: PaneRecord["id"]) { return this.records.find((record) => record.id === id); }
  public async findByTmuxPaneId(tmuxPaneId: string) { return this.records.find((record) => record.tmuxPaneId === tmuxPaneId); }
  public async findByTmuxPaneIdentity(_tmuxServerId: string, tmuxPaneId: string) { return this.records.find((record) => record.tmuxPaneId === tmuxPaneId); }
  public async upsert(record: PaneRecord) { this.records = [record]; }
  public async pruneStalePanes(_activePaneIds: readonly PaneRecord["id"][], _olderThan: string, _tmuxServerScope: string) { return 0; }
}

class FakeGateway implements PaneGateway {
  public inputs: string[] = [];
  public sizes: Array<[number, number]> = [];
  public async sendInput(_paneId: PaneRecord["id"], input: string) { this.inputs.push(input); }
  public async resize(_paneId: PaneRecord["id"], cols: number, rows: number) { this.sizes.push([cols, rows]); }
  public async close() {}
}

type ApplicationFixture = { repository: FakePanes; gateway: FakeGateway };
type ApplicationStep =
  | { type: "list" }
  | { type: "send"; paneId: string; input: string }
  | { type: "resize"; paneId: string; cols: number; rows: number };
type ApplicationResult = PaneRecord[] | undefined;
type ApplicationContext = { inputs: readonly string[]; sizes: readonly (readonly [number, number])[] };

const applicationFixture = (): FixtureHandle<ApplicationFixture> => ({
  fixture: { repository: new FakePanes(), gateway: new FakeGateway() },
});

const applicationCases = [
  {
    name: "lists panes through the repository port",
    steps: [{ type: "list" }],
    assert: [hasNoError<ApplicationContext, ApplicationResult>(), returns<ApplicationContext, ApplicationResult>([pane])],
  },
  {
    name: "sends input for a known pane",
    steps: [{ type: "send", paneId: "pane-1", input: "yes\n" }],
    assert: [hasNoError<ApplicationContext, ApplicationResult>(), returns<ApplicationContext, ApplicationResult>(undefined), hasObserved<ApplicationContext, ApplicationResult>("inputs", ["yes\n"])],
  },
  {
    name: "resizes a known pane",
    steps: [{ type: "resize", paneId: "pane-1", cols: 80, rows: 24 }],
    assert: [hasNoError<ApplicationContext, ApplicationResult>(), returns<ApplicationContext, ApplicationResult>(undefined), hasObserved<ApplicationContext, ApplicationResult>("sizes", [[80, 24]])],
  },
  {
    name: "rejects an unknown pane before sending input",
    steps: [{ type: "send", paneId: "missing", input: "x" }],
    assert: [hasError<ApplicationContext, ApplicationResult>({ message: "Pane not found: missing" }), hasObserved<ApplicationContext, ApplicationResult>("inputs", [])],
  },
  {
    name: "rejects an unknown pane before resizing",
    steps: [{ type: "resize", paneId: "missing", cols: 80, rows: 24 }],
    assert: [hasError<ApplicationContext, ApplicationResult>({ message: "Pane not found: missing" }), hasObserved<ApplicationContext, ApplicationResult>("sizes", [])],
  },
] satisfies readonly ScenarioCase<"default", ApplicationStep, ApplicationResult, ApplicationContext>[];

const applicationTable: ScenarioTable<ApplicationFixture, "default", ApplicationStep, ApplicationResult, ApplicationContext> = {
  defaultFixture: applicationFixture,
  cases: applicationCases,
  execute: async (fixture, steps) => {
    let result: ApplicationResult;
    for (const step of steps) {
      if (step.type === "list") result = await new ListPanes(fixture.repository).execute();
      if (step.type === "send") {
        await new SendPaneInput(fixture.repository, fixture.gateway).execute(PaneId.create(step.paneId), step.input);
        result = undefined;
      }
      if (step.type === "resize") {
        await new ResizePane(fixture.repository, fixture.gateway).execute(PaneId.create(step.paneId), step.cols, step.rows);
        result = undefined;
      }
    }
    return result;
  },
  observe: (fixture) => ({ inputs: [...fixture.gateway.inputs], sizes: fixture.gateway.sizes.map((size) => [...size] as [number, number]) }),
};

describe("application use cases", () => {
  runScenarioTable(it as unknown as TestRegistrar, applicationTable);
});
