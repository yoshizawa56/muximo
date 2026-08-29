/** CLI-facing muximod lifecycle and endpoint utilities. */

export type { MuximodClientPathOverrides, MuximodClientPaths } from "./client-paths.js";
export {
  defaultMuximodInstanceDirectory,
  muximodControlSocketMaxBytes,
  resolveMuximodClientPaths,
  validateMuximodControlSocketPath,
} from "./client-paths.js";
export type {
  MuximodConfig,
  MuximodForegroundConflictPolicy,
  MuximodLifecycle,
  MuximodLifecycleOptions,
  MuximodRuntimeEnvironment,
} from "./launch.js";
export { createMuximodLifecycle } from "./launch.js";
