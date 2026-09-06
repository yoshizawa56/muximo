import type { InstancePaths } from "@muximo/instance-contract";

export type MuximoCliRuntimeOptions = {
  instanceDirectory: InstancePaths["instanceDirectory"];
  configFile: InstancePaths["configFile"];
  databaseFile: InstancePaths["databaseFile"];
  hookOutputDirectory: InstancePaths["hookOutputDirectory"];
  pidFile: InstancePaths["pidFile"];
  controlSocket: InstancePaths["controlSocket"];
  logFile: InstancePaths["logFile"];
  webPidFile: InstancePaths["webPidFile"];
  webLogFile: InstancePaths["webLogFile"];
  webStartLockDirectory: InstancePaths["webStartLockDirectory"];
  serveStateFile: InstancePaths["serveStateFile"];
  opencodeRegistryFile: InstancePaths["opencodeRegistryFile"];
  verbose: boolean;
};
