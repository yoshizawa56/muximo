import type { WorkspaceRecord } from "@muximo/domain";
import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  hasNoError,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { ApplicationClock } from "../../ports/application.js";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { WorkspaceDirectoryPort } from "../../ports/workspace.js";
import { DeleteWorkspace } from "./delete-workspace.js";
import { ListWorkspaces } from "./list-workspaces.js";
import { RegisterWorkspace } from "./register-workspace.js";
import { UpdateWorkspace } from "./update-workspace.js";
import type { UpdateWorkspaceInput } from "./workspace-inputs.js";
import { WorkspaceRecordFactory } from "./workspace-record-factory.js";

type WorkspaceStep =
  | { type: "register"; input: { directory: string; name?: string; worktreeCopyPatterns?: string[] } }
  | { type: "update"; selector: string; input: UpdateWorkspaceInput }
  | { type: "delete"; selector: string };

type WorkspaceFixture = {
  repository: FakeWorkspaceRepository;
  list: ListWorkspaces;
  register: RegisterWorkspace;
  update: UpdateWorkspace;
  delete: DeleteWorkspace;
  auditEvents: string[];
};

type WorkspaceContext = {
  recordCount: number;
  recordName: string;
  rootPath: string;
  patterns: readonly string[];
  updatedAt: string;
  auditEvents: readonly string[];
  insertCalls: number;
  upsertCalls: number;
};

const scenarios = [
  {
    name: "registers and updates metadata through the workspace use cases",
    steps: [
      { type: "register", input: { directory: "/work/project", name: "project", worktreeCopyPatterns: [".env"] } },
      {
        type: "update",
        selector: "project",
        input: { name: "renamed", appendCopyPatterns: ["config/**/*.local.json"] },
      },
    ],
    assert: [
      hasNoError<WorkspaceContext, WorkspaceRecord>(),
      hasObserved<WorkspaceContext, WorkspaceRecord>("recordCount", 1),
      hasObserved<WorkspaceContext, WorkspaceRecord>("recordName", "renamed"),
      hasObserved<WorkspaceContext, WorkspaceRecord>("rootPath", "/work/project"),
      hasObserved<WorkspaceContext, WorkspaceRecord>("patterns", [".env", "config/**/*.local.json"]),
      hasObserved<WorkspaceContext, WorkspaceRecord>("updatedAt", "2026-08-16T00:00:00.000Z"),
      hasObserved<WorkspaceContext, WorkspaceRecord>("auditEvents", ["workspace.created", "workspace.updated"]),
    ],
  },
  {
    name: "deletes only the registered record through the workspace use cases",
    steps: [
      { type: "register", input: { directory: "/work/project" } },
      { type: "delete", selector: "workspace-1" },
    ],
    assert: [
      hasNoError<WorkspaceContext, WorkspaceRecord>(),
      hasObserved<WorkspaceContext, WorkspaceRecord>("recordCount", 0),
      hasObserved<WorkspaceContext, WorkspaceRecord>("recordName", ""),
      hasObserved<WorkspaceContext, WorkspaceRecord>("patterns", []),
      hasObserved<WorkspaceContext, WorkspaceRecord>("auditEvents", ["workspace.created", "workspace.deleted"]),
    ],
  },
  {
    name: "rejects a duplicate registration with one insert and no upsert or audit",
    fixture: "duplicate",
    steps: [{ type: "register", input: { directory: "/work/project" } }],
    assert: [
      hasError<WorkspaceContext, WorkspaceRecord>({ code: "workspace_already_registered" }),
      hasObserved<WorkspaceContext, WorkspaceRecord>("recordCount", 1),
      hasObserved<WorkspaceContext, WorkspaceRecord>("insertCalls", 1),
      hasObserved<WorkspaceContext, WorkspaceRecord>("upsertCalls", 0),
      hasObserved<WorkspaceContext, WorkspaceRecord>("auditEvents", []),
    ],
  },
] satisfies readonly ScenarioCase<"duplicate", WorkspaceStep, WorkspaceRecord, WorkspaceContext>[];

const table: ScenarioTable<WorkspaceFixture, "duplicate", WorkspaceStep, WorkspaceRecord, WorkspaceContext> = {
  defaultFixture: createWorkspaceFixture,
  fixtures: { duplicate: createDuplicateWorkspaceFixture },
  cases: scenarios,
  execute: async (fixture, steps) => {
    let result: WorkspaceRecord | undefined;
    for (const step of steps) {
      result =
        step.type === "register"
          ? await fixture.register.execute(step.input)
          : step.type === "update"
            ? await fixture.update.execute(step.selector, step.input)
            : await fixture.delete.execute(step.selector);
    }
    return result!;
  },
  observe: async (fixture) => {
    const records = await fixture.repository.list();
    const record = records[0];
    return {
      recordCount: records.length,
      recordName: record?.name ?? "",
      rootPath: record?.rootPath ?? "",
      patterns: record?.worktreeCopyPatterns ?? [],
      updatedAt: record?.updatedAt ?? "",
      auditEvents: [...fixture.auditEvents],
      insertCalls: fixture.repository.insertCalls,
      upsertCalls: fixture.repository.upsertCalls,
    };
  },
};

describe("workspace use case lifecycle", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createWorkspaceFixture(): FixtureHandle<WorkspaceFixture> {
  const repository = new FakeWorkspaceRepository();
  const directory = new FakeWorkspaceDirectory();
  const auditEvents: string[] = [];
  const timestamps = ["2026-08-15T00:00:00.000Z", "2026-08-16T00:00:00.000Z"];
  let timestampIndex = 0;
  const clock: ApplicationClock = {
    now: () => timestamps[Math.min(timestampIndex++, timestamps.length - 1)]!,
  };
  const factory = new WorkspaceRecordFactory(directory, clock);
  const audit = {
    record: (eventType: string) => {
      auditEvents.push(eventType);
    },
  };
  return {
    fixture: {
      repository,
      auditEvents,
      list: new ListWorkspaces(repository),
      register: new RegisterWorkspace(repository, factory, audit),
      update: new UpdateWorkspace(repository, directory, factory, audit),
      delete: new DeleteWorkspace(repository, directory, audit),
    },
  };
}

function createDuplicateWorkspaceFixture(): FixtureHandle<WorkspaceFixture> {
  const handle = createWorkspaceFixture();
  handle.fixture.repository.seed(
    Workspace.create({
      id: WorkspaceId.create("workspace-1"),
      rootPath: "/work/project",
      name: "project",
      isGit: true,
      worktreeCopyPatterns: [],
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }),
  );
  return handle;
}

class FakeWorkspaceRepository implements WorkspaceRepository {
  private records: WorkspaceRecord[] = [];

  public insertCalls = 0;
  public upsertCalls = 0;

  public seed(record: WorkspaceRecord): void {
    this.records.push(record);
  }

  public async findById(id: string): Promise<WorkspaceRecord | undefined> {
    return this.records.find((record) => record.id === id);
  }

  public async list(): Promise<WorkspaceRecord[]> {
    return [...this.records];
  }

  public async insert(record: WorkspaceRecord): Promise<boolean> {
    this.insertCalls += 1;
    if (this.records.some((candidate) => candidate.id === record.id)) return false;
    this.records.push(record);
    return true;
  }

  public async upsert(record: WorkspaceRecord): Promise<void> {
    this.upsertCalls += 1;
    this.records = [...this.records.filter((candidate) => candidate.id !== record.id), record];
  }

  public async delete(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
  }
}

class FakeWorkspaceDirectory implements WorkspaceDirectoryPort {
  public resolveDirectory(directory: string) {
    return {
      id: WorkspaceId.create("workspace-1"),
      rootPath: directory === "project" ? "/work/project" : directory,
      name: "project",
      isGit: true,
    };
  }

  public resolveHook(path: string): string {
    return `/work/project/${path}`;
  }
}
