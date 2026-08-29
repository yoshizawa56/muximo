import { homedir } from "node:os";
import { join } from "node:path";
import { defineOptions } from "../options/index.js";

export const globalOptionSpecs = defineOptions(
  {
    key: "environment",
    flags: ["--env <profile>"],
    description: "Select the runtime environment profile.",
    exposure: "both",
    availableIn: ["development"],
    environment: {
      name: "MUXIMO_ENV",
      description: "Runtime environment profile.",
    },
    defaultValue: "prod",
  },
  {
    key: "stateRoot",
    flags: ["--state-root <path>"],
    description: "Root directory for environment state.",
    exposure: "both",
    environment: {
      name: "MUXIMO_STATE_ROOT",
      description: "Root directory for environment state.",
    },
    defaultValue: (environment: NodeJS.ProcessEnv) => join(environment.HOME ?? homedir(), ".local", "state", "muximo"),
    completion: { kind: "directory" },
  },
  {
    key: "muximodHost",
    flags: ["--muximod-host <host>"],
    description: "Local host address for muximod.",
    exposure: "both",
    environment: {
      name: "MUXIMO_MUXIMOD_HOST",
      description: "Local host address for muximod.",
    },
    defaultValue: "127.0.0.1",
  },
  {
    key: "muximodPort",
    flags: ["--muximod-port <port>"],
    description: "Local port for muximod.",
    exposure: "both",
    environment: {
      name: "MUXIMO_MUXIMOD_PORT",
      description: "Local port for muximod.",
      decode: (value) => Number(value),
    },
    defaultValue: 4317,
    completion: { kind: "integer" },
  },
  {
    key: "muximodServePort",
    flags: ["--muximod-serve-port <port>"],
    description: "External port for the muximod Serve route.",
    exposure: "both",
    environment: {
      name: "MUXIMO_MUXIMOD_SERVE_PORT",
      description: "External port for the muximod Serve route.",
      decode: (value) => Number(value),
    },
    defaultValue: 8444,
    completion: { kind: "integer" },
  },
  {
    key: "schemaMode",
    flags: ["--schema-mode <mode>"],
    description: "Database schema synchronization mode.",
    exposure: "both",
    environment: {
      name: "MUXIMO_SCHEMA_MODE",
      description: "Database schema synchronization mode.",
    },
    defaultValue: "migrate",
    completion: { kind: "choices", values: ["migrate", "push"] },
  },
  {
    key: "logLevel",
    flags: ["--log-level <level>"],
    description: "Minimum daemon log level.",
    exposure: "both",
    environment: {
      name: "MUXIMO_LOG_LEVEL",
      description: "Minimum daemon log level.",
    },
    defaultValue: "info",
    completion: { kind: "choices", values: ["error", "warn", "info", "debug"] },
  },
  {
    key: "logFile",
    flags: ["--log-file <path>"],
    description: "Daemon log file path.",
    exposure: "both",
    environment: {
      name: "MUXIMO_LOG_FILE",
      description: "Daemon log file path.",
    },
    completion: { kind: "file" },
  },
  {
    key: "allowedOrigins",
    flags: ["--allowed-origin <origin>"],
    description: "Allowed browser origin for muximod.",
    exposure: "both",
    environment: {
      name: "MUXIMOD_ALLOWED_ORIGINS",
      description: "Comma-separated allowed browser origins for muximod.",
      decode: (value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
    },
    defaultValue: [],
    repeatable: true,
    completion: { kind: "url" },
  },
  {
    key: "verbose",
    flags: ["-v, --verbose"],
    description: "Show detailed diagnostics on the attached terminal.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "codexRemote",
    description: "Override the Codex remote endpoint used by the local backend.",
    exposure: "environment",
    environment: {
      name: "MUXIMO_CODEX_REMOTE",
      description: "Codex remote endpoint used by the local backend.",
    },
    defaultValue: "unix://",
  },
);
