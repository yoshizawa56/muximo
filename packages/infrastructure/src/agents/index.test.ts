import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type AgentManifest,
  type AgentObservation,
  AgentPluginRegistry,
  type DetectInput,
  type DetectionResult,
  shellPlugin,
} from "./index.js";

type RegistryContext = { retrieved: boolean };
const registryCases = [
  {
    name: "registers and lists plugin manifests",
    input: { pluginId: "shell" },
    assert: [
      returns<RegistryContext, AgentManifest[]>([shellPlugin.manifest]),
      hasObserved<RegistryContext, AgentManifest[]>("retrieved", true),
    ],
  },
] satisfies readonly OperationCase<"default", { pluginId: string }, AgentManifest[], RegistryContext>[];

const registryTable: OperationTable<
  AgentPluginRegistry,
  "default",
  { pluginId: string },
  AgentManifest[],
  RegistryContext
> = {
  defaultFixture: () => ({ fixture: new AgentPluginRegistry() }),
  cases: registryCases,
  execute: (fixture, input) => {
    fixture.register(shellPlugin);
    return fixture.list().filter((manifest) => manifest.id === input.pluginId);
  },
  observe: (fixture) => ({ retrieved: fixture.get("shell") === shellPlugin }),
};

type AgentStep = { type: "detect"; input: DetectInput } | { type: "exit"; code: number | null; signal: string | null };
type AgentScenarioResult = { detection: DetectionResult | null; observations: AgentObservation[] };
type AgentScenarioContext = {};

const agentCases = [
  {
    name: "detects an ordinary shell and emits an exit observation",
    steps: [
      { type: "detect", input: { command: "/bin/zsh", args: [], cwd: "/tmp", environment: {} } },
      { type: "exit", code: 0, signal: null },
    ],
    assert: [
      returns<AgentScenarioContext, AgentScenarioResult>({
        detection: { agentId: "shell", confidence: 1, name: "zsh" },
        observations: [{ type: "state_changed", state: "completed", reason: "shell exited" }],
      }),
    ],
  },
] satisfies readonly ScenarioCase<"default", AgentStep, AgentScenarioResult, AgentScenarioContext>[];

const agentTable: ScenarioTable<undefined, "default", AgentStep, AgentScenarioResult, AgentScenarioContext> = {
  defaultFixture: noFixture(),
  cases: agentCases,
  execute: async (_fixture, steps) => {
    let detection: DetectionResult | null = null;
    let observations: AgentObservation[] = [];
    for (const step of steps) {
      if (step.type === "detect") detection = await shellPlugin.detect(step.input);
      if (step.type === "exit")
        observations = shellPlugin.createObserver().onExit({ code: step.code, signal: step.signal });
    }
    return { detection, observations };
  },
  observe: () => ({}),
};

describe("agent plugin registry", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, registryTable);
  runScenarioTable(register, agentTable);
});
