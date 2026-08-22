import type { WorkspaceRecord } from "@muximo/domain";
import { WorkspaceId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasNoError,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
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
  auditEvents: readonly string[];
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
] satisfies readonly ScenarioCase<"default", WorkspaceStep, WorkspaceRecord, WorkspaceContext>[];

const table: ScenarioTable<WorkspaceFixture, "default", WorkspaceStep, WorkspaceRecord, WorkspaceContext> = {
  defaultFixture: createWorkspaceFixture,
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
      auditEvents: [...fixture.auditEvents],
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
  const now = (): string => "2026-08-15T00:00:00.000Z";
  const factory = new WorkspaceRecordFactory(directory, now);
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

class FakeWorkspaceRepository implements WorkspaceRepository {
  private records: WorkspaceRecord[] = [];

  public async findById(id: string): Promise<WorkspaceRecord | undefined> {
    return this.records.find((record) => record.id === id);
  }

  public async list(): Promise<WorkspaceRecord[]> {
    return [...this.records];
  }

  public async insert(record: WorkspaceRecord): Promise<boolean> {
    if (this.records.some((candidate) => candidate.id === record.id)) return false;
    this.records.push(record);
    return true;
  }

  public async upsert(record: WorkspaceRecord): Promise<void> {
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
