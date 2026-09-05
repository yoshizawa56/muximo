import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  hasNoError,
  hasObserved,
  resolveMaybePromise,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect, type Layer } from "effect";
import { describe, it } from "vitest";
import type { ApplicationEffect } from "../../effect.js";
import type { WorkspaceDirectoryInfo } from "../../ports/workspace.js";
import { deleteWorkspace } from "./delete-workspace.js";
import { registerWorkspace } from "./register-workspace.js";
import { updateWorkspace } from "./update-workspace.js";
import type { UpdateWorkspaceInput } from "./workspace-inputs.js";
import {
  type WorkspaceAudit,
  type WorkspaceDirectory,
  type WorkspaceRepository,
  type WorkspaceServices,
  workspaceLayer,
} from "./workspace-services.js";

type WorkspaceStep =
  | { type: "register"; input: { directory: string; name?: string } }
  | { type: "update"; selector: string; input: UpdateWorkspaceInput }
  | { type: "delete"; selector: string };

type WorkspaceFixture = {
  repository: FakeWorkspaceRepository;
  auditEvents: string[];
  layer: Layer.Layer<WorkspaceServices>;
};

type WorkspaceContext = {
  recordCount: number;
  recordName: string;
  rootPath: string;
  auditEvents: readonly string[];
  insertCalls: number;
  upsertCalls: number;
};

const scenarios = [
  {
    name: "registers and updates metadata through the workspace use cases",
    steps: [
      { type: "register", input: { directory: "/work/project", name: "project" } },
      {
        type: "update",
        selector: "project",
        input: { name: "renamed" },
      },
    ],
    assert: [
      hasNoError<WorkspaceContext, Workspace>(),
      hasObserved<WorkspaceContext, Workspace>("recordCount", 1),
      hasObserved<WorkspaceContext, Workspace>("recordName", "renamed"),
      hasObserved<WorkspaceContext, Workspace>("rootPath", "/work/project"),
      hasObserved<WorkspaceContext, Workspace>("auditEvents", ["workspace.created", "workspace.updated"]),
    ],
  },
  {
    name: "deletes only the registered record through the workspace use cases",
    steps: [
      { type: "register", input: { directory: "/work/project" } },
      { type: "delete", selector: "project" },
    ],
    assert: [
      hasNoError<WorkspaceContext, Workspace>(),
      hasObserved<WorkspaceContext, Workspace>("recordCount", 0),
      hasObserved<WorkspaceContext, Workspace>("recordName", ""),
      hasObserved<WorkspaceContext, Workspace>("auditEvents", ["workspace.created", "workspace.deleted"]),
    ],
  },
  {
    name: "rejects a duplicate registration with one insert and no upsert or audit",
    fixture: "duplicate",
    steps: [{ type: "register", input: { directory: "/work/project" } }],
    assert: [
      hasError<WorkspaceContext, Workspace>({
        code: "workspace_already_registered",
        _tag: "WorkspaceAlreadyRegisteredError",
      }),
      hasObserved<WorkspaceContext, Workspace>("recordCount", 1),
      hasObserved<WorkspaceContext, Workspace>("insertCalls", 1),
      hasObserved<WorkspaceContext, Workspace>("upsertCalls", 0),
      hasObserved<WorkspaceContext, Workspace>("auditEvents", []),
    ],
  },
] satisfies readonly ScenarioCase<"duplicate", WorkspaceStep, Workspace, WorkspaceContext>[];

const table: ScenarioTable<WorkspaceFixture, "duplicate", WorkspaceStep, Workspace, WorkspaceContext> = {
  defaultFixture: createWorkspaceFixture,
  fixtures: { duplicate: createDuplicateWorkspaceFixture },
  cases: scenarios,
  execute: (fixture, steps) =>
    Effect.gen(function* () {
      let result: Workspace | undefined;
      for (const step of steps) {
        result =
          step.type === "register"
            ? yield* registerWorkspace(step.input)
            : step.type === "update"
              ? yield* updateWorkspace(step.selector, step.input)
              : yield* deleteWorkspace(step.selector);
      }
      return result!;
    }).pipe(Effect.provide(fixture.layer)),
  observe: async (fixture) => {
    const records = await resolveMaybePromise(fixture.repository.list());
    const record = records[0];
    return {
      recordCount: records.length,
      recordName: record?.name ?? "",
      rootPath: record?.rootPath ?? "",
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
  const audit: WorkspaceAudit = {
    record: (eventType: string) =>
      Effect.sync(() => {
        auditEvents.push(eventType);
      }),
  };
  const layer = workspaceLayer({ repository, directories: directory, audit });
  return {
    fixture: { repository, auditEvents, layer },
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
    }),
  );
  return handle;
}

class FakeWorkspaceRepository implements WorkspaceRepository {
  private records: Workspace[] = [];

  public insertCalls = 0;
  public upsertCalls = 0;

  public seed(record: Workspace): void {
    this.records.push(record);
  }

  public findById(id: WorkspaceId): ApplicationEffect<Workspace | undefined> {
    return Effect.succeed(this.records.find((record) => record.id === id));
  }

  public list(): ApplicationEffect<Workspace[]> {
    return Effect.succeed([...this.records]);
  }

  public insert(record: Workspace): ApplicationEffect<boolean> {
    return Effect.sync(() => {
      this.insertCalls += 1;
      if (this.records.some((candidate) => candidate.id === record.id)) return false;
      this.records.push(record);
      return true;
    });
  }

  public upsert(record: Workspace): ApplicationEffect<void> {
    return Effect.sync(() => {
      this.upsertCalls += 1;
      this.records = [...this.records.filter((candidate) => candidate.id !== record.id), record];
    });
  }

  public delete(id: WorkspaceId): ApplicationEffect<void> {
    return Effect.sync(() => {
      this.records = this.records.filter((record) => record.id !== id);
    });
  }
}

class FakeWorkspaceDirectory implements WorkspaceDirectory {
  public resolveDirectory(directory: string): ApplicationEffect<WorkspaceDirectoryInfo> {
    return Effect.succeed({
      id: WorkspaceId.create("workspace-1"),
      rootPath: directory === "project" ? "/work/project" : directory,
      name: "project",
      isGit: true,
    });
  }

  public resolveHook(path: string): ApplicationEffect<string> {
    return Effect.succeed(`/work/project/${path}`);
  }
}
