/**
 * OpenCode V1 plugin: discovers or bootstraps one OpenCode server per project
 * root and drives a managed `opencode attach` TUI as the primary process.
 *
 * The plugin never touches OpenCode configuration; it only passes lifecycle
 * and transport arguments (worktree, loopback host, port, session id) and
 * mirrors the agent session name onto the OpenCode session title. The server
 * is a shared service reference, never a launch-plan sidecar owned by a
 * session.
 */

import { Effect } from "effect";
import { runEffectAsPromise } from "../../effect.js";

import type {
  AgentManifest,
  AgentMonitor,
  AgentMonitorContext,
  AgentObservation,
  AgentPluginV1,
  DetectInput,
  LaunchInput,
  LaunchPlan,
  LaunchSpec,
} from "../index.js";
import { agentCapabilities } from "../index.js";
import { OpenCodeClient, type OpenCodeLog } from "./client.js";
import { OpenCodeMonitor, type OpenCodeMonitorOptions } from "./monitor.js";
import { defaultOpenCodeRegistryFile, type OpenCodeServerEntry, OpenCodeServerManager } from "./server.js";

export type OpenCodePluginOptions = {
  serverManager?: OpenCodeServerManager;
  clientFactory?: (baseUrl: string, directory: string) => OpenCodeClient;
  monitorFactory?: (options: OpenCodeMonitorOptions) => AgentMonitor;
  environment?: NodeJS.ProcessEnv;
  registryFile?: string;
  serverUrl?: string;
  executable?: string;
  attachExecutable?: string;
  onLog?: OpenCodeLog;
};

export class OpenCodePluginError extends Error {
  public constructor(
    message: string,
    public readonly code = "opencode_launch_failed",
  ) {
    super(message);
    this.name = "OpenCodePluginError";
  }
}

export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): AgentPluginV1 {
  const manager =
    options.serverManager ??
    new OpenCodeServerManager({
      registryFile: options.registryFile ?? defaultOpenCodeRegistryFile(options.environment),
      environment: options.environment,
      serverUrl: options.serverUrl,
      executable: options.executable,
    });

  return {
    manifest: {
      id: "opencode",
      version: "1",
      displayName: "OpenCode",
      capabilities: [...agentCapabilities],
    } satisfies AgentManifest,

    async detect(input: DetectInput) {
      const command = input.command.split("/").at(-1)?.toLowerCase();
      return command === "opencode" ? { confidence: 1, agentId: "opencode", name: "OpenCode" } : null;
    },

    async launch(_input: LaunchInput): Promise<LaunchSpec> {
      throw new OpenCodePluginError(
        "OpenCode panes need a prepared server connection; use prepareLaunch",
        "opencode_requires_prepare",
      );
    },

    createObserver() {
      return {
        onOutput: () => [],
        onExit: ({ code }): AgentObservation[] => [
          {
            type: "state_changed",
            state: code === 0 ? "completed" : "failed",
            reason: "OpenCode TUI exited",
          },
        ],
      };
    },

    async prepareLaunch(
      input: LaunchInput & {
        monitorContext: AgentMonitorContext;
        resumeSessionId?: string | null;
        signal?: AbortSignal;
      },
    ): Promise<LaunchPlan> {
      return runEffectAsPromise(prepareLaunch(manager, options, input));
    },

    actions() {
      return [];
    },
  };
}

function prepareLaunch(
  manager: OpenCodeServerManager,
  options: OpenCodePluginOptions,
  input: LaunchInput & {
    monitorContext: AgentMonitorContext;
    resumeSessionId?: string | null;
    signal?: AbortSignal;
  },
): Effect.Effect<LaunchPlan, Error> {
  return Effect.gen(function* () {
    const root = input.cwd;
    input.signal?.throwIfAborted();
    const entry = yield* manager.ensure(root, input.signal);
    input.signal?.throwIfAborted();
    const baseUrl = `http://127.0.0.1:${entry.port}`;
    const client =
      options.clientFactory?.(baseUrl, root) ?? new OpenCodeClient(baseUrl, { onLog: options.onLog, directory: root });
    const sessionId = yield* resolveSessionId(client, entry, input.resumeSessionId ?? null, input.name, input.signal);
    input.signal?.throwIfAborted();
    const monitor =
      options.monitorFactory?.({
        baseUrl,
        sessionId,
        workspaceRoot: root,
        client,
      }) ?? new OpenCodeMonitor({ baseUrl, sessionId, workspaceRoot: root, client });
    const attachExecutable = options.attachExecutable ?? "opencode";

    return {
      primary: {
        command: attachExecutable,
        args: ["attach", baseUrl, "--dir", root, "--session", sessionId],
        cwd: root,
        environment: { ...input.environment },
      },
      monitor,
      backendSessionId: sessionId,
    };
  });
}

function resolveSessionId(
  client: OpenCodeClient,
  entry: OpenCodeServerEntry,
  resumeSessionId: string | null,
  sessionName: string | undefined,
  signal?: AbortSignal,
): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    if (!resumeSessionId) {
      const created = yield* client.createSession(sessionName, signal);
      if (!created)
        return yield* Effect.fail(
          new OpenCodePluginError(
            `OpenCode server on port ${entry.port} did not accept a new session; check 'opencode serve' diagnostics`,
          ),
        );
      return created;
    }
    const exists = yield* client.sessionExists(resumeSessionId, signal);
    if (!exists)
      return yield* Effect.fail(
        new OpenCodePluginError(
          `OpenCode session ${resumeSessionId} no longer exists on the OpenCode server; start a new session instead of resuming`,
          "opencode_session_not_found",
        ),
      );
    // Keep the session title in sync with the agent session name. This is
    // cosmetic; a title update failure must not block the resume.
    if (sessionName) yield* client.setSessionTitle(resumeSessionId, sessionName, signal);
    return resumeSessionId;
  });
}
