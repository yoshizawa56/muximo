import { join } from "node:path";
import type { MuximodWebSettings } from "@muximo/contract/control";
import { createWebDaemonManager, type WebDaemonManager, type WebDaemonStatus } from "@muximo/infrastructure/cli-client";

export type WebProcessStatus = {
  state: WebDaemonStatus["state"] | "disabled";
  pid?: number;
  url: string;
  logFile: string;
};

export type WebProcessManager = {
  ensure(): Promise<WebProcessStatus>;
  start(): Promise<WebProcessStatus>;
  restart(): Promise<WebProcessStatus>;
  stop(): Promise<WebProcessStatus>;
  status(): Promise<WebProcessStatus>;
};

export type WebProcessManagerOptions = {
  pidFile: string;
  logFile: string;
  lockDirectory: string;
  webRoot: string;
  environment: NodeJS.ProcessEnv;
  resolveSettings: () => Promise<MuximodWebSettings["proxy"]>;
  available?: boolean;
  command?: string;
  viteEntrypoint?: string;
};

/** Resolves daemon-owned Web settings and delegates process mechanics to the CLI host adapter. */
export function createWebProcessManager(options: WebProcessManagerOptions): WebProcessManager {
  return {
    ensure: runEnabledLifecycle,
    start: runEnabledLifecycle,
    restart: async () => {
      const settings = await options.resolveSettings();
      if (!settings.enabled) {
        await createManager(defaultSettings()).stop();
        return presentDisabled(settings);
      }
      assertAvailable();
      return createManager(settings).restart();
    },
    stop: async () => createManager(defaultSettings()).stop(),
    status: async () => {
      const settings = await options.resolveSettings();
      if (!settings.enabled) {
        await createManager(defaultSettings()).stop();
        return presentDisabled(settings);
      }
      assertAvailable();
      return createManager(settings).status();
    },
  };

  async function runEnabledLifecycle(): Promise<WebProcessStatus> {
    const settings = await options.resolveSettings();
    if (!settings.enabled) {
      await createManager(defaultSettings()).stop();
      return presentDisabled(settings);
    }
    assertAvailable();
    const manager = createManager(settings);
    const current = await manager.status();
    if (current.state === "stale") await manager.stop();
    return manager.start();
  }

  function createManager(settings: Pick<MuximodWebSettings["proxy"], "host" | "port">): WebDaemonManager {
    return createWebDaemonManager({
      pidFile: options.pidFile,
      lockDirectory: options.lockDirectory,
      host: settings.host,
      port: settings.port,
      cwd: options.webRoot,
      command: options.command ?? process.execPath,
      args: [
        options.viteEntrypoint ?? join(options.webRoot, "node_modules", "vite", "bin", "vite.js"),
        "--host",
        settings.host,
        "--port",
        String(settings.port),
        "--strictPort",
      ],
      environment: options.environment,
      logFile: options.logFile,
    });
  }

  function assertAvailable(): void {
    if (options.available === false) throw new Error("Vite Web proxy is unavailable in this build");
  }

  function presentDisabled(settings: MuximodWebSettings["proxy"]): WebProcessStatus {
    return {
      state: "disabled",
      url: `http://${settings.host.includes(":") ? `[${settings.host}]` : settings.host}:${settings.port}`,
      logFile: options.logFile,
    };
  }
}

function defaultSettings(): Pick<MuximodWebSettings["proxy"], "host" | "port"> {
  return { host: "127.0.0.1", port: 5227 };
}
