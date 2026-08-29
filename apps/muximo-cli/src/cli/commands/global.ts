import { defineOptions } from "../options/index.js";

export const globalOptionSpecs = defineOptions(
  {
    key: "environment",
    flags: ["--env <environment>"],
    description: "Select the runtime environment profile.",
    exposure: "both",
    environment: {
      name: "MUXIMO_ENV",
      description: "Runtime environment profile.",
    },
    defaultValue: "prod",
    completion: { kind: "choices", values: ["local", "stg", "prod"] },
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
  },
);
