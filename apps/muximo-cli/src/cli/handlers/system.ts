import type {
  DaemonEnsureResult,
  DaemonOptions,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
  StartDaemonInput,
} from "@muximo/application";
import { DaemonHealthError } from "@muximo/application";
import type { DoctorReport, TailscaleServeResult } from "@muximo/infrastructure";
import type {
  CliDaemonInput,
  CliDevInput,
  CliDoctorInput,
  CliHandlers,
  CliIo,
  CliServeInput,
} from "../commands/types.js";
import {
  presentDaemonError,
  presentDaemonRestart,
  presentDaemonStart,
  presentDaemonStatus,
  presentDaemonStop,
} from "../presenters/daemon.js";
import { presentDoctorReport } from "../presenters/doctor.js";
import { presentServeResult } from "../presenters/serve.js";

type StatusService<Input> = {
  execute(input: Input): Promise<number> | number;
};

type AsyncService<Input, Result> = {
  execute(input: Input): Promise<Result>;
};

export type ServeResult = TailscaleServeResult;

export type SystemHandlerDependencies = {
  doctor: { execute(input: CliDoctorInput): Promise<DoctorReport> };
  daemon: {
    defaults: Pick<DaemonOptions, "pidFile" | "controlSocket">;
    start: AsyncService<StartDaemonInput, DaemonStartResult>;
    status: AsyncService<DaemonOptions, DaemonStatusResult>;
    stop: AsyncService<DaemonOptions, DaemonStopResult>;
    restart: AsyncService<DaemonOptions, DaemonRestartResult>;
    ensure: AsyncService<DaemonOptions, DaemonEnsureResult>;
  };
  serve: { execute(input: CliServeInput): Promise<ServeResult> };
  dev: StatusService<CliDevInput>;
  io: CliIo;
};

export function createSystemHandlers(
  dependencies: SystemHandlerDependencies,
): Pick<CliHandlers, "doctor" | "daemon" | "serve" | "dev"> {
  return {
    doctor: async (input) => presentDoctorReport(await dependencies.doctor.execute(input), dependencies.io),
    daemon: async (input) => {
      try {
        const options = toDaemonOptions(input, dependencies.daemon.defaults);
        switch (input.command) {
          case "start":
            return presentDaemonStart(
              await dependencies.daemon.start.execute({ options, foreground: input.foreground }),
              dependencies.io,
            );
          case "status":
            return presentDaemonStatus(await dependencies.daemon.status.execute(options), dependencies.io);
          case "stop":
            return presentDaemonStop(await dependencies.daemon.stop.execute(options), dependencies.io);
          case "restart":
            return presentDaemonRestart(await dependencies.daemon.restart.execute(options), dependencies.io);
          case "ensure":
            return presentDaemonStart(
              { kind: "background", result: await dependencies.daemon.ensure.execute(options) },
              dependencies.io,
            );
        }
      } catch (error) {
        if (!(error instanceof DaemonHealthError)) throw error;
        return presentDaemonError(error, dependencies.io);
      }
    },
    serve: async (input) => {
      return presentServeResult(await dependencies.serve.execute(input), dependencies.io);
    },
    dev: (input) => Promise.resolve(dependencies.dev.execute(input)),
  };
}

function toDaemonOptions(
  input: CliDaemonInput,
  defaults: Pick<DaemonOptions, "pidFile" | "controlSocket">,
): DaemonOptions {
  return {
    host: input.host,
    port: input.port,
    pidFile: input.pidFile ?? defaults.pidFile,
    controlSocket: input.controlSocket ?? defaults.controlSocket,
    muximodBaseUrl: input.muximodBaseUrl,
    logLevel: input.logLevel,
    logFile: input.logFile,
    refreshServers: input.refreshServers,
    allowedOrigins: input.allowedOrigins,
  };
}
