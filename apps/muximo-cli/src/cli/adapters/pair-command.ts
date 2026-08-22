import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import type { PairDevice } from "@muximo/application";

export type PairCommandIo = {
  out: Writable;
  input: Readable;
};

export type PairDisplay = "browser" | "terminal";

export type ParsedPairCommandOptions = {
  controlSocket: string;
  muximodBaseUrl?: string;
  withoutServe: boolean;
  display: PairDisplay;
};

export type ResolvedPairCommandOptions = {
  controlSocket: string;
  muximodBaseUrl: string;
  display: PairDisplay;
};

export type PairDeviceRuntime = {
  useCase: PairDevice;
  close(): void | Promise<void>;
};

export type PairDeviceRuntimeFactory = (
  options: ResolvedPairCommandOptions,
  io: PairCommandIo,
) => Promise<PairDeviceRuntime>;

export type PairMuximodUrlResolver = (input: { withoutServe: boolean; environment: NodeJS.ProcessEnv }) => Promise<string>;

export type PairCommandOptions = {
  env?: NodeJS.ProcessEnv;
  io: PairCommandIo;
  createRuntime: PairDeviceRuntimeFactory;
  resolveMuximodBaseUrl: PairMuximodUrlResolver;
  resolveDefaultControlSocket: (environment: NodeJS.ProcessEnv) => string;
  validateControlSocket: (path: string) => void;
};

export class PairCommandError extends Error {}

/** CLI adapter for the application-level `PairDevice` use case. */
export class PairCommand {
  private readonly env: NodeJS.ProcessEnv;

  public constructor(private readonly options: PairCommandOptions) {
    this.env = { ...process.env, ...options.env };
  }

  public async execute(args: string[]): Promise<number> {
    if (args.includes("-h") || args.includes("--help")) {
      this.write("Usage: muximo pair [--open|--terminal] [--without-serve] [--muximod-base-url URL] [--control-socket PATH]\n");
      return 0;
    }

    const parsed = parsePairCommandOptions(
      args,
      this.env,
      this.options.resolveDefaultControlSocket,
      this.options.validateControlSocket,
    );
    const muximodBaseUrl = parsed.muximodBaseUrl ?? await this.options.resolveMuximodBaseUrl({
      withoutServe: parsed.withoutServe,
      environment: this.env,
    });
    const runtime = await this.options.createRuntime({ controlSocket: parsed.controlSocket, muximodBaseUrl, display: parsed.display }, this.options.io);
    try {
      const result = await runtime.useCase.execute({
        muximodBaseUrl,
      });
      if (result.status === "approved") {
        this.write(`Approved. deviceId: ${result.deviceId}\n`);
        return 0;
      }
      this.write("Pairing was rejected.\n");
      return 1;
    } finally {
      await runtime.close();
    }
  }

  private write(value: string): void {
    this.options.io.out.write(value);
  }
}

export function parsePairCommandOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  resolveDefaultControlSocket: (environment: NodeJS.ProcessEnv) => string,
  validateControlSocket: (path: string) => void,
): ParsedPairCommandOptions {
  let controlSocket = env.MUXIMOD_CONTROL_SOCKET ?? resolveDefaultControlSocket(env);
  let muximodBaseUrl = env.MUXIMOD_PAIRING_BASE_URL;
  let withoutServe = false;
  let display: PairDisplay = "browser";
  let explicitDisplay: PairDisplay | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--control-socket") controlSocket = resolve(requireValue(argument, args[++index]));
    else if (argument.startsWith("--control-socket=")) controlSocket = resolve(argument.slice("--control-socket=".length));
    else if (argument === "--without-serve") withoutServe = true;
    else if (argument === "--muximod-base-url") muximodBaseUrl = requireValue(argument, args[++index]);
    else if (argument.startsWith("--muximod-base-url=")) muximodBaseUrl = argument.slice("--muximod-base-url=".length);
    else if (argument === "--open") {
      if (explicitDisplay === "terminal") throw new PairCommandError("muximo pair options --open and --terminal are mutually exclusive");
      explicitDisplay = "browser";
      display = "browser";
    } else if (argument === "--terminal") {
      if (explicitDisplay === "browser") throw new PairCommandError("muximo pair options --open and --terminal are mutually exclusive");
      explicitDisplay = "terminal";
      display = "terminal";
    }
    else throw new PairCommandError(`unknown muximo pair option: ${argument}`);
  }

  validateControlSocket(controlSocket);
  return { controlSocket, muximodBaseUrl, withoutServe, display };
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new PairCommandError(`${option} requires a value`);
  return value;
}
