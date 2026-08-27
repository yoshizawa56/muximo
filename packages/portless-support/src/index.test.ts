import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  configurePortlessService,
  loadDevelopmentEnvironment,
  parseDotEnv,
  resolvePortlessPeerUrl,
  resolveRepositoryRoot,
} from "./index.js";

type EmptyContext = {};

type DotEnvInput = {
  contents: string;
  source?: string;
};

const dotEnvCases = [
  {
    name: "parses comments exports quotes and inline comments",
    input: {
      contents: `# local development\nexport API_HOST="127.0.0.1"\nTOKEN='a#token'\nPORT=4317 # muximod\n`,
    },
    assert: [
      returns<EmptyContext, Record<string, string>>({
        API_HOST: "127.0.0.1",
        TOKEN: "a#token",
        PORT: "4317",
      }),
    ],
  },
  {
    name: "reports the source line for malformed dotenv input",
    input: { contents: "VALID=value\nnot dotenv", source: "fixture.env" },
    assert: [hasError<EmptyContext, Record<string, string>>({ message: "fixture.env:2: expected KEY=VALUE" })],
  },
] satisfies readonly OperationCase<"default", DotEnvInput, Record<string, string>, EmptyContext>[];

const dotEnvTable: OperationTable<undefined, "default", DotEnvInput, Record<string, string>, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: dotEnvCases,
  execute: (_fixture, input) => parseDotEnv(input.contents, input.source),
  observe: () => ({}),
};

type EnvironmentFixture = {
  root: string;
  environment: NodeJS.ProcessEnv;
};

const environmentFixtures = {
  default: () => createEnvironmentFixture("FROM_FILE=file-value\nPORT=4317\n", {}),
  explicit: () => createEnvironmentFixture("FROM_FILE=file-value\nPORT=4317\n", { PORT: "9999" }),
};

type EnvironmentFixtureKey = keyof typeof environmentFixtures;

const environmentCases = [
  {
    name: "loads values from the repository env file",
    fixture: "default",
    input: undefined,
    assert: [hasObserved<EnvironmentContext, undefined>("values", { FROM_FILE: "file-value", PORT: "4317" })],
  },
  {
    name: "preserves an explicitly supplied environment value",
    fixture: "explicit",
    input: undefined,
    assert: [hasObserved<EnvironmentContext, undefined>("values", { FROM_FILE: "file-value", PORT: "9999" })],
  },
] satisfies readonly OperationCase<EnvironmentFixtureKey, undefined, undefined, EnvironmentContext>[];

type EnvironmentContext = {
  values: NodeJS.ProcessEnv;
};

const environmentTable: OperationTable<
  EnvironmentFixture,
  EnvironmentFixtureKey,
  undefined,
  undefined,
  EnvironmentContext
> = {
  defaultFixture: environmentFixtures.default,
  fixtures: environmentFixtures,
  cases: environmentCases,
  execute: (fixture) => {
    loadDevelopmentEnvironment({ repositoryRoot: fixture.root, environment: fixture.environment });
  },
  observe: (fixture) => ({
    values: {
      FROM_FILE: fixture.environment.FROM_FILE,
      PORT: fixture.environment.PORT,
    },
  }),
};

type PortlessContext = {
  environment: {
    HOST: string | undefined;
    VITE_DEV_HOST: string | undefined;
    VITE_DEV_PORT: string | undefined;
  };
  peerUrl: string | undefined;
};

type PortlessResult = {
  environment: NodeJS.ProcessEnv;
  peerUrl: string | undefined;
};

const portlessCases = [
  {
    name: "derives the peer host from the worktree-aware Portless URL",
    input: undefined,
    assert: [
      hasObserved<PortlessContext, PortlessResult>("environment", {
        HOST: "127.0.0.1",
        VITE_DEV_HOST: "127.0.0.1",
        VITE_DEV_PORT: "4567",
      }),
      hasObserved<PortlessContext, PortlessResult>("peerUrl", "https://feature.muximod.localhost/"),
    ],
  },
] satisfies readonly OperationCase<"default", undefined, PortlessResult, PortlessContext>[];

const portlessTable: OperationTable<undefined, "default", undefined, PortlessResult, PortlessContext> = {
  defaultFixture: noFixture(),
  cases: portlessCases,
  execute: () => {
    const environment: NodeJS.ProcessEnv = {
      HOST: "127.0.0.1",
      PORT: "4567",
      PORTLESS_URL: "https://feature.web.localhost",
    };
    const repositoryRoot = resolveRepositoryRoot();
    configurePortlessService("web", { repositoryRoot, environment });
    const peerUrl = resolvePortlessPeerUrl("web", { repositoryRoot, environment });
    return { environment, peerUrl: peerUrl?.toString() };
  },
  observe: (_fixture, outcome) => {
    if (!outcome.ok) {
      return {
        environment: { HOST: undefined, VITE_DEV_HOST: undefined, VITE_DEV_PORT: undefined },
        peerUrl: undefined,
      };
    }
    return {
      environment: {
        HOST: outcome.value.environment.HOST,
        VITE_DEV_HOST: outcome.value.environment.VITE_DEV_HOST,
        VITE_DEV_PORT: outcome.value.environment.VITE_DEV_PORT,
      },
      peerUrl: outcome.value.peerUrl,
    };
  },
};

function createEnvironmentFixture(
  contents: string,
  environment: NodeJS.ProcessEnv,
): { fixture: EnvironmentFixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "muximo-portless-support-"));
  writeFileSync(join(root, ".env"), contents, "utf8");
  return {
    fixture: { root, environment },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Portless development support", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, dotEnvTable);
  runOperationTable(register, environmentTable);
  runOperationTable(register, portlessTable);
});
