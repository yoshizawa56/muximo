import { ensureTailscaleServe, type TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";

type ServeFixture = {
  ensureCalls: Array<{ origins: readonly string[]; environment: NodeJS.ProcessEnv }>;
  commands: Array<{ args: readonly string[]; environment: NodeJS.ProcessEnv }>;
  origin?: string;
  daemonOrigin?: string;
  wildcard?: boolean;
  ensureCount?: number;
  commandCount?: number;
  cleanupCount?: number;
};

type ServeInput = {
  environment: NodeJS.ProcessEnv;
  allowedOrigins?: readonly string[];
  failCommand?: boolean;
};
const createFixture = () => ({ fixture: { ensureCalls: [], commands: [] } });

const cases = [
  {
    name: "passes the exact configured Tailscale origin before starting muximod",
    input: {
      environment: { MUXIMO_TAILSCALE_HOSTNAME: "web.tailnet.ts.net", PATH: "/usr/bin" },
    },
    assert: [
      hasObserved<ServeFixture, TailscaleServeResult>("origin", "https://web.tailnet.ts.net"),
      hasObserved<ServeFixture, TailscaleServeResult>("daemonOrigin", "https://web.tailnet.ts.net"),
      hasObserved<ServeFixture, TailscaleServeResult>("wildcard", false),
    ],
  },
  {
    name: "passes explicit origins without requiring a discovered hostname",
    input: {
      environment: {
        PATH: "/usr/bin",
        MUXIMOD_ALLOWED_ORIGINS: "https://configured.example",
        MUXIMOD_PAIRING_BASE_URL: "https://configured.example",
      },
      allowedOrigins: ["https://configured.example"],
    },
    assert: [
      hasObserved<ServeFixture, TailscaleServeResult>("origin", "https://configured.example"),
      hasObserved<ServeFixture, TailscaleServeResult>("daemonOrigin", "https://configured.example"),
      hasObserved<ServeFixture, TailscaleServeResult>("wildcard", false),
    ],
  },
  {
    name: "rejects a wildcard environment before daemon startup",
    input: {
      environment: { MUXIMOD_ALLOWED_ORIGINS: "*", PATH: "/usr/bin" },
    },
    assert: [
      hasError<ServeFixture, TailscaleServeResult>({ message: "wildcard browser origins are not allowed" }),
      hasObserved<ServeFixture, TailscaleServeResult>("ensureCount", 0),
      hasObserved<ServeFixture, TailscaleServeResult>("commandCount", 0),
    ],
  },
  {
    name: "rejects credentials in configured browser origins without exposing them",
    input: {
      environment: {
        MUXIMOD_ALLOWED_ORIGINS: "https://user:password@configured.example",
        PATH: "/usr/bin",
      },
    },
    assert: [
      hasError<ServeFixture, TailscaleServeResult>({ message: "browser origin must not contain credentials" }),
      hasObserved<ServeFixture, TailscaleServeResult>("ensureCount", 0),
      hasObserved<ServeFixture, TailscaleServeResult>("commandCount", 0),
    ],
  },
  {
    name: "rejects credentials in an explicit pairing URL without exposing them",
    input: {
      environment: {
        MUXIMOD_PAIRING_BASE_URL: "https://user:password@configured.example",
        PATH: "/usr/bin",
      },
    },
    assert: [
      hasError<ServeFixture, TailscaleServeResult>({
        message: "MUXIMOD_PAIRING_BASE_URL must not contain credentials",
      }),
      hasObserved<ServeFixture, TailscaleServeResult>("ensureCount", 0),
      hasObserved<ServeFixture, TailscaleServeResult>("commandCount", 0),
    ],
  },
  {
    name: "cleans up a daemon started by the serve command when Tailscale fails",
    input: {
      environment: { MUXIMO_TAILSCALE_HOSTNAME: "web.tailnet.ts.net", PATH: "/usr/bin" },
      failCommand: true,
    },
    assert: [
      hasError<ServeFixture, TailscaleServeResult>({ message: "tailscale failed" }),
      hasObserved<ServeFixture, TailscaleServeResult>("cleanupCount", 1),
    ],
  },
] satisfies readonly OperationCase<"default", ServeInput, TailscaleServeResult, ServeFixture>[];

const table: OperationTable<ServeFixture, "default", ServeInput, TailscaleServeResult, ServeFixture> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) =>
    ensureTailscaleServe(
      {
        provider: "tailscale",
        foreground: false,
        muximodHost: "127.0.0.1",
        muximodPort: 4317,
        externalPort: 443,
        logLevel: "info",
        allowedOrigins: input.allowedOrigins,
      },
      {
        ensureMuximod: async (_options, allowedOrigins) => {
          fixture.ensureCalls.push({
            origins: allowedOrigins,
            environment: { MUXIMOD_ALLOWED_ORIGINS: allowedOrigins.join(",") },
          });
          return {
            cleanup: async () => {
              fixture.cleanupCount = (fixture.cleanupCount ?? 0) + 1;
            },
          };
        },
        runCommand: async (_command, args, commandOptions) => {
          fixture.commands.push({ args, environment: commandOptions.env });
          if (input.failCommand) throw new Error("tailscale failed");
          return { stdout: "", stderr: "" };
        },
      },
      input.environment,
    ),
  observe: (fixture, result) => {
    fixture.origin = result.ok ? result.value.allowedOrigins[0] : undefined;
    fixture.daemonOrigin = fixture.ensureCalls[0]?.origins[0];
    fixture.wildcard = result.ok ? result.value.allowedOrigins.includes("*") : false;
    fixture.ensureCount = fixture.ensureCalls.length;
    fixture.commandCount = fixture.commands.length;
    fixture.cleanupCount = fixture.cleanupCount ?? 0;
    return fixture;
  },
};

describe("muximo serve origin composition", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
