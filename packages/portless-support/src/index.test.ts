import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type PortlessServiceRoute,
  parseDotEnv,
  resolvePortlessPeerUrl,
  resolvePortlessRoute,
  resolvePortlessService,
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

type ServiceUrlContext = {};
type ServiceUrlInput = { value: string };
const serviceUrlCases = [
  {
    name: "rejects credentials in the Portless public URL",
    input: { value: "https://user:password@feature.web.localhost" },
    assert: [
      hasError<ServiceUrlContext, ReturnType<typeof resolvePortlessService>>({
        message: "PORTLESS_URL must not contain credentials",
      }),
    ],
  },
] satisfies readonly OperationCase<
  "default",
  ServiceUrlInput,
  ReturnType<typeof resolvePortlessService>,
  ServiceUrlContext
>[];

const serviceUrlTable: OperationTable<
  undefined,
  "default",
  ServiceUrlInput,
  ReturnType<typeof resolvePortlessService>,
  ServiceUrlContext
> = {
  defaultFixture: noFixture(),
  cases: serviceUrlCases,
  execute: (_fixture, input) =>
    resolvePortlessService("web", {
      repositoryRoot: resolveRepositoryRoot(),
      environment: { PORTLESS_URL: input.value },
    }),
  observe: () => ({}),
};

type RouteFixture = {
  root: string;
  stateDirectory: string;
  routesPath: string;
  lockPath: string;
  environment: NodeJS.ProcessEnv;
  hostname: string;
};

type RouteStep = "stable" | "locked-corrupt" | "locked-empty" | "unlocked-empty";
type RouteResult = { routePort: number; routePid: number } | undefined;
type RouteContext = { routePort: number | undefined; routePid: number | undefined };

const routeCases = [
  {
    name: "reads a stable Portless route",
    input: "stable",
    assert: [
      hasObserved<RouteContext, RouteResult>("routePort", 4317),
      hasObserved<RouteContext, RouteResult>("routePid", process.pid),
    ],
  },
  {
    name: "keeps the last route while Portless writes a corrupt locked file",
    input: "locked-corrupt",
    assert: [
      hasObserved<RouteContext, RouteResult>("routePort", 4317),
      hasObserved<RouteContext, RouteResult>("routePid", process.pid),
    ],
  },
  {
    name: "accepts an empty route after the write lock is removed",
    input: "unlocked-empty",
    assert: [
      hasObserved<RouteContext, RouteResult>("routePort", undefined),
      hasObserved<RouteContext, RouteResult>("routePid", undefined),
    ],
  },
] satisfies readonly OperationCase<"default", RouteStep, RouteResult, RouteContext>[];

const routeTable: OperationTable<RouteFixture, "default", RouteStep, RouteResult, RouteContext> = {
  defaultFixture: () => createRouteFixture(),
  cases: routeCases,
  execute: (fixture, step) => {
    writeStableRoute(fixture);
    const initial = resolvePortlessRoute("web", { repositoryRoot: fixture.root, environment: fixture.environment });
    if (step === "stable") return toRouteResult(initial);

    if (step === "locked-corrupt") writeFileSync(fixture.routesPath, "[{", "utf8");
    if (step === "locked-empty") writeFileSync(fixture.routesPath, "[]", "utf8");
    if (step === "unlocked-empty") writeFileSync(fixture.routesPath, "[]", "utf8");
    if (step !== "unlocked-empty") mkdirSync(fixture.lockPath);
    const route = resolvePortlessRoute("web", { repositoryRoot: fixture.root, environment: fixture.environment });
    if (step !== "unlocked-empty") rmSync(fixture.lockPath, { recursive: true, force: true });
    return toRouteResult(route);
  },
  observe: (_fixture, result) => ({
    routePort: result.ok ? result.value?.routePort : undefined,
    routePid: result.ok ? result.value?.routePid : undefined,
  }),
};

function createRouteFixture(): { fixture: RouteFixture; cleanup: () => void } {
  const root = resolveRepositoryRoot();
  const stateDirectory = mkdtempSync(join(tmpdir(), "muximo-portless-routes-"));
  const environment: NodeJS.ProcessEnv = {
    PORTLESS_URL: "https://feature.web.localhost",
    PORTLESS_STATE_DIR: stateDirectory,
  };
  const runtime = resolvePortlessService("web", { repositoryRoot: root, environment });
  return {
    fixture: {
      root,
      stateDirectory,
      routesPath: join(stateDirectory, "routes.json"),
      lockPath: join(stateDirectory, "routes.lock"),
      environment,
      hostname: runtime.hostname,
    },
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
  };
}

function writeStableRoute(fixture: RouteFixture): void {
  writeFileSync(
    fixture.routesPath,
    JSON.stringify([{ hostname: fixture.hostname, port: 4317, pid: process.pid }]),
    "utf8",
  );
}

function toRouteResult(route: PortlessServiceRoute | undefined): RouteResult {
  return route ? { routePort: route.routePort, routePid: route.routePid } : undefined;
}

describe("Portless development support", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, dotEnvTable);
  runOperationTable(register, environmentTable);
  runOperationTable(register, portlessTable);
  runOperationTable(register, serviceUrlTable);
  runOperationTable(register, routeTable);
});
