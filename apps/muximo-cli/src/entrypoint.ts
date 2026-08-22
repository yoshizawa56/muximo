import { PairDevice } from "@muximo/application";
import { createDefaultAgentPluginRegistry, errorFields, errorMessage, resolveMuximodPaths, validateMuximodControlSocketPath, type Logger } from "@muximo/infrastructure";
import {
  MuximoCommand,
  MuximoCommandError,
  MuximodPairingControlAdapter,
  resolvePairMuximodBaseUrl,
} from "./cli/host/index.js";
import {
  BrowserPairingPresenter,
  PairCommand,
  PairCommandError,
  TerminalPairingPresenter,
  type PairCommandIo,
  type PairDeviceRuntime,
  type ResolvedPairCommandOptions,
} from "./cli/adapters/index.js";

export async function runMuximoCli(args: string[], logger: Logger): Promise<void> {
  const commandName = args[0] ?? "help";
  const startedAt = Date.now();
  logger.debug("cli.command_started", { command: commandName, argumentCount: args.length });
  try {
    if (args[0] === "daemon") {
      const daemonStartedAt = Date.now();
      logger.debug("daemon.command_started", { argumentCount: args.length - 1 });
      try {
        const { runMuximodCommand } = await import("@muximo/muximod/runtime");
        await runMuximodCommand(args.slice(1));
        logger.debug("daemon.command_finished", { durationMs: Date.now() - daemonStartedAt });
      } catch (error) {
        logger.debug("daemon.command_failed", { durationMs: Date.now() - daemonStartedAt, ...errorFields(error) });
        reportError(logger, "muximo daemon", error, 2, false);
      }
    } else if (args[0] === "pair") {
      const pairStartedAt = Date.now();
      logger.debug("pair.command_started", { argumentCount: args.length - 1 });
      const command = new PairCommand({
        env: process.env,
        io: { out: process.stdout, input: process.stdin },
        resolveMuximodBaseUrl: resolvePairMuximodBaseUrl,
        resolveDefaultControlSocket: (environment) => resolveMuximodPaths(environment).controlSocket,
        validateControlSocket: validateMuximodControlSocketPath,
        createRuntime: (options, io) => createPairDeviceRuntime(options, io, logger),
      });
      try {
        process.exitCode = await command.execute(args.slice(1));
        logger.debug("pair.command_finished", { status: process.exitCode, durationMs: Date.now() - pairStartedAt });
      } catch (error) {
        logger.debug("pair.command_failed", { durationMs: Date.now() - pairStartedAt, ...errorFields(error) });
        reportError(logger, "muximo pair", error, error instanceof PairCommandError ? 2 : 1, !(error instanceof PairCommandError));
      }
    } else if (args[0] === "serve") {
      try {
        const { runServeCommand } = await import("./cli/host/serve-command.js");
        process.exitCode = await runServeCommand(args.slice(1), { logger });
      } catch (error) {
        reportError(logger, "muximo serve", error, 2, false);
      }
    } else if (args[0] === "dev") {
      try {
        const { runDevCommand } = await import("./cli/host/dev-command.js");
        process.exitCode = await runDevCommand(args.slice(1), process.env, {
          verbose: logger.isEnabled("debug"),
          logger,
        });
      } catch (error) {
        reportError(logger, "muximo dev", error, 2, false);
      }
    } else {
      const command = new MuximoCommand({ logger, agentPlugins: createDefaultAgentPluginRegistry() });
      try {
        process.exitCode = await command.execute(args);
      } catch (error) {
        reportError(logger, "muximo", error, error instanceof MuximoCommandError ? 2 : 1, !(error instanceof MuximoCommandError));
      } finally {
        command.close();
      }
    }
  } finally {
    logger.debug("cli.command_finished", { command: commandName, status: process.exitCode ?? 0, durationMs: Date.now() - startedAt });
    logger.close();
  }
}

async function createPairDeviceRuntime(
  options: ResolvedPairCommandOptions,
  io: PairCommandIo,
  logger?: Logger,
): Promise<PairDeviceRuntime> {
  const startedAt = Date.now();
  logger?.debug("pair.control_connecting");
  try {
    const control = await MuximodPairingControlAdapter.connect(options.controlSocket);
    logger?.debug("pair.control_connected", { durationMs: Date.now() - startedAt });
    if (options.display === "terminal") {
      return {
        useCase: new PairDevice(
          control,
          new TerminalPairingPresenter({ out: io.out, input: io.input }),
        ),
        close: () => control.close(),
      };
    }

    const presenter = new BrowserPairingPresenter({ out: io.out, input: io.input });
    return {
      useCase: new PairDevice(control, presenter),
      close: async () => {
        await presenter.close();
        control.close();
      },
    };
  } catch (error) {
    logger?.debug("pair.control_connection_failed", { durationMs: Date.now() - startedAt, ...errorFields(error) });
    throw error;
  }
}

function reportError(logger: Logger, prefix: string, error: unknown, status: number, unexpected: boolean): void {
  if (logger.isEnabled("debug")) {
    logger.debug("cli.command_failed", {
      prefix,
      status,
      unexpected,
      ...errorFields(error),
    });
  }
  const message = errorMessage(error);
  if (!unexpected || error instanceof MuximoCommandError || error instanceof PairCommandError) {
    process.stderr.write(`${prefix}: ${message}\n`);
  } else {
    process.stderr.write(`${prefix}: ${message}\n`);
    if (!logger.isEnabled("debug")) {
      process.exitCode = status;
      return;
    }
    logger.error("process.unhandled_error", {
      message: `unexpected error: ${message}`,
      ...errorFields(error),
    });
  }
  process.exitCode = status;
}
