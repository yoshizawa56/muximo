import { isIP } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const muximodConfigFileName = "config.json";
export const muximodDatabaseFileName = "muximod.sqlite";
export const muximodPidFileName = "muximod.pid";
export const muximodControlSocketFileName = "muximod.sock";
export const muximodLogFileName = "muximod.log";
export const muximodServeStateFileName = "serve.json";
export const muximodHookDirectoryName = "hooks";

export type InstancePaths = {
  instanceDirectory: string;
  configFile: string;
  databaseFile: string;
  hookOutputDirectory: string;
  pidFile: string;
  controlSocket: string;
  logFile: string;
  serveStateFile: string;
  opencodeRegistryFile: string;
};

/** Resolves the complete on-disk layout owned by one muximod instance. */
export function resolveInstancePaths(instanceDirectory: string): InstancePaths {
  const directory = resolve(instanceDirectory);
  return {
    instanceDirectory: directory,
    configFile: join(directory, muximodConfigFileName),
    databaseFile: join(directory, muximodDatabaseFileName),
    hookOutputDirectory: join(directory, muximodHookDirectoryName),
    pidFile: join(directory, muximodPidFileName),
    controlSocket: join(directory, muximodControlSocketFileName),
    logFile: join(directory, muximodLogFileName),
    serveStateFile: join(directory, muximodServeStateFileName),
    opencodeRegistryFile: join(directory, "opencode-servers.json"),
  };
}

export function defaultMuximodInstanceDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return join(environment.HOME ?? homedir(), ".local", "state", "muximo");
}

/** Returns whether a component can safely bind without a public bind opt-in. */
export function isLoopbackOrPrivateBindHost(value: string): boolean {
  if (value === "localhost") return true;
  const version = isIP(value);
  if (version === 4) return isLoopbackOrPrivateIpv4(value);
  if (version === 6) return value === "::1" || /^(?:fc|fd)/iu.test(value);
  return false;
}

function isLoopbackOrPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254)
  );
}
