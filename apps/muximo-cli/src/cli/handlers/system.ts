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
import type { MuximodControlLogResult } from "@muximo/contract/control";
import type { DoctorReport, ServeRouteState, TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import type { CliDaemonInput, CliDoctorInput, CliHandlers, CliIo, CliServeInput } from "../commands/types.js";
import {
  presentDaemonError,
  presentDaemonLog,
  presentDaemonRestart,
  presentDaemonStart,
  presentDaemonStatus,
  presentDaemonStop,
} from "../presenters/daemon.js";
import { presentDoctorReport } from "../presenters/doctor.js";
import { presentServeResult } from "../presenters/serve.js";

type AsyncService<Input, Result> = {
  execute(input: Input): Promise<Result>;
};

export type ServeResult =
  | { command: "tailscale"; result: TailscaleServeResult; state: ServeRouteState }
  | {
      command: "status";
      state?: ServeRouteState;
      routeAvailable?: boolean;
      providerOutput?: string;
      providerError?: string;
    }
  | { command: "stop"; state: "stopped" | "already-stopped"; publicUrl?: string };

export type SystemHandlerDependencies = {
  doctor: { execute(input: CliDoctorInput): Promise<DoctorReport> };
  daemon: {
    defaults: DaemonOptions;
    start: AsyncService<StartDaemonInput, DaemonStartResult>;
    status: AsyncService<DaemonOptions, DaemonStatusResult>;
    stop: AsyncService<DaemonOptions, DaemonStopResult>;
    restart: AsyncService<DaemonOptions, DaemonRestartResult>;
    ensure: AsyncService<DaemonOptions, DaemonEnsureResult>;
    log: AsyncService<{ lines: number }, MuximodControlLogResult>;
  };
  serve: { execute(input: CliServeInput): Promise<ServeResult> };
  io: CliIo;
};

export function createSystemHandlers(
  dependencies: SystemHandlerDependencies,
): Pick<CliHandlers, "doctor" | "daemon" | "serve"> {
  return {
    doctor: async (input) => presentDoctorReport(await dependencies.doctor.execute(input), dependencies.io),
    daemon: async (input) => {
      try {
        const options = toDaemonOptions(input, dependencies.daemon.defaults);
        switch (input.command) {
          case "start":
            return presentDaemonStart(await dependencies.daemon.start.execute({ options }), dependencies.io);
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
          case "log":
            return presentDaemonLog(
              await dependencies.daemon.log.execute({ lines: input.lines ?? 100 }),
              dependencies.io,
            );
        }
      } catch (error) {
        if (!(error instanceof DaemonHealthError)) throw error;
        return presentDaemonError(error, dependencies.io);
      }
    },
    serve: async (input) => {
      const result = await dependencies.serve.execute(input);
      return presentServeResult(result, dependencies.io);
    },
  };
}

function toDaemonOptions(input: CliDaemonInput, defaults: DaemonOptions): DaemonOptions {
  return {
    ...defaults,
    refreshServers: input.refreshServers,
  };
}
