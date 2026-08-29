export type MuximoCliRuntimeOptions = {
  environmentName?: string;
  stateRoot: string;
  muximodInstanceDirectory: string;
  muximodHost: string;
  muximodPort: number;
  muximodServePort: number;
  schemaMode: "migrate" | "push";
  logLevel: "error" | "warn" | "info" | "debug";
  logFile: string;
  allowedOrigins: readonly string[];
  codexRemote: string;
  verbose: boolean;
};
