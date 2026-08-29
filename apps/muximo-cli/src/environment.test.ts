import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolveMuximoEnvironmentProfile } from "./environment.js";

type FixtureKey = "complete" | "missing-local" | "invalid-local";
type ProfileFixture = { repositoryRoot: string; home: string };
type ProfileInput = {
  name: "local" | "stg" | "prod";
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
};
type ProfileResult = ReturnType<typeof resolveMuximoEnvironmentProfile>;
type ProfileContext = {
  name: string | null;
  stateRoot: string | null;
  muximodInstanceDirectory: string | null;
  muximodHost: string | null;
  port: string | null;
  schemaMode: string | null;
  webHost: string | null;
  webPort: string | null;
  logFile: string | null;
};

const cases = [
  {
    name: "profile values override ambient dotenv values when local is selected",
    fixture: "complete",
    input: {
      name: "local",
      environment: {
        MUXIMO_MUXIMOD_PORT: "4999",
        MUXIMO_SCHEMA_MODE: "migrate",
        MUXIMO_WEB_PORT: "4998",
        MUXIMO_TAILSCALE_HOSTNAME: "machine.tailnet.ts.net",
      },
    },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("name", "local"),
      hasObserved<ProfileContext, ProfileResult>("muximodHost", "127.0.0.1"),
      hasObserved<ProfileContext, ProfileResult>("port", "4317"),
      hasObserved<ProfileContext, ProfileResult>("schemaMode", "push"),
      hasObserved<ProfileContext, ProfileResult>("webHost", "127.0.0.1"),
      hasObserved<ProfileContext, ProfileResult>("webPort", "5227"),
    ],
  },
  {
    name: "staging selection does not inherit local ports or schema mode",
    fixture: "complete",
    input: {
      name: "stg",
      environment: {
        MUXIMO_MUXIMOD_PORT: "4317",
        MUXIMO_SCHEMA_MODE: "push",
        MUXIMO_WEB_PORT: "5227",
      },
    },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("name", "stg"),
      hasObserved<ProfileContext, ProfileResult>("port", "4327"),
      hasObserved<ProfileContext, ProfileResult>("schemaMode", "migrate"),
      hasObserved<ProfileContext, ProfileResult>("webPort", "5237"),
    ],
  },
  {
    name: "accepts an explicit private bind address for local development",
    fixture: "complete",
    input: {
      name: "local",
      environment: {
        MUXIMO_MUXIMOD_HOST: "192.168.50.10",
        MUXIMO_WEB_HOST: "192.168.50.10",
      },
    },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("muximodHost", "192.168.50.10"),
      hasObserved<ProfileContext, ProfileResult>("webHost", "192.168.50.10"),
    ],
  },
  {
    name: "rejects a wildcard bind address",
    fixture: "complete",
    input: {
      name: "local",
      environment: { MUXIMO_WEB_HOST: "0.0.0.0" },
    },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /must be localhost/ })],
  },
  {
    name: "production uses built-in state and port defaults instead of ambient profile values",
    fixture: "complete",
    input: {
      name: "prod",
      environment: {
        MUXIMO_MUXIMOD_PORT: "4999",
        MUXIMO_SCHEMA_MODE: "push",
        MUXIMO_WEB_PORT: "4998",
        MUXIMO_WEB_SERVE_PORT: "443",
      },
    },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("name", "prod"),
      hasObserved<ProfileContext, ProfileResult>("stateRoot", "<home>/.local/state/muximo"),
      hasObserved<ProfileContext, ProfileResult>("port", "4317"),
      hasObserved<ProfileContext, ProfileResult>("schemaMode", "migrate"),
      hasObserved<ProfileContext, ProfileResult>("webPort", "5227"),
      hasObserved<ProfileContext, ProfileResult>("logFile", "<home>/.local/state/muximo/prod/muximod/muximod.log"),
    ],
  },
  {
    name: "reports a missing required local profile",
    fixture: "missing-local",
    input: { name: "local", environment: {} },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /environment profile was not found/ })],
  },
  {
    name: "reports the source line for invalid profile syntax",
    fixture: "invalid-local",
    input: { name: "local", environment: {} },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /\.env\.local:2: expected KEY=VALUE/ })],
  },
] satisfies readonly OperationCase<FixtureKey, ProfileInput, ProfileResult, ProfileContext>[];

const table: OperationTable<ProfileFixture, FixtureKey, ProfileInput, ProfileResult, ProfileContext> = {
  defaultFixture: () => createFixture("complete"),
  fixtures: {
    complete: () => createFixture("complete"),
    "missing-local": () => createFixture("missing-local"),
    "invalid-local": () => createFixture("invalid-local"),
  },
  cases,
  execute: (fixture, input) =>
    resolveMuximoEnvironmentProfile({
      name: input.name,
      cwd: input.cwd ?? fixture.repositoryRoot,
      environment: { HOME: fixture.home, ...input.environment },
    }),
  observe: (fixture, result) =>
    result.ok
      ? {
          name: result.value.name,
          stateRoot: result.value.stateRoot.replace(fixture.home, "<home>"),
          muximodInstanceDirectory: result.value.muximodInstanceDirectory.replace(fixture.home, "<home>"),
          muximodHost: result.value.environment.MUXIMOD_HOST ?? null,
          port: result.value.environment.MUXIMOD_PORT ?? null,
          schemaMode: result.value.environment.MUXIMO_SCHEMA_MODE ?? null,
          webHost: result.value.environment.VITE_DEV_HOST ?? null,
          webPort: result.value.environment.VITE_DEV_PORT ?? null,
          logFile: result.value.environment.MUXIMO_LOG_FILE?.replace(fixture.home, "<home>") ?? null,
        }
      : {
          name: null,
          stateRoot: null,
          muximodInstanceDirectory: null,
          muximodHost: null,
          port: null,
          schemaMode: null,
          webHost: null,
          webPort: null,
          logFile: null,
        },
};

function createFixture(kind: FixtureKey) {
  const root = mkdtempSync(join(tmpdir(), "muximo-environment-test-"));
  const repositoryRoot = join(root, "repository");
  const home = join(root, "home");
  mkdirSync(join(repositoryRoot, "apps"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repositoryRoot, "package.json"), "{}\n");
  writeFileSync(
    join(repositoryRoot, ".env.stg"),
    "MUXIMO_MUXIMOD_PORT=4327\nMUXIMO_SCHEMA_MODE=migrate\nMUXIMO_WEB_PORT=5237\n",
  );
  if (kind === "complete") {
    writeFileSync(
      join(repositoryRoot, ".env.local"),
      "MUXIMO_MUXIMOD_PORT=4317\nMUXIMO_SCHEMA_MODE=push\nMUXIMO_WEB_PORT=5227\n",
    );
  }
  if (kind === "invalid-local") {
    writeFileSync(join(repositoryRoot, ".env.local"), "MUXIMO_MUXIMOD_PORT=4317\nnot a profile line\n");
  }
  return {
    fixture: { repositoryRoot, home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Muximo environment profiles", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
