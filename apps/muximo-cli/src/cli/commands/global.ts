import { defineOptions } from "../options/index.js";

export const globalOptionSpecs = defineOptions(
  {
    key: "verbose",
    flags: ["-v, --verbose"],
    description: "Show detailed diagnostics on the attached terminal.",
    exposure: "cli",
    defaultValue: false,
  },
  {
    key: "instanceDirectory",
    description: "Select the directory used for muximod state and runtime files.",
    exposure: "environment",
    environment: {
      name: "MUXIMOD_INSTANCE_DIR",
      description: "Directory used for muximod state and runtime files.",
    },
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
