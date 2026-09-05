import { defaultMuximodInstanceDirectory } from "@muximo/instance-contract";
import { defineOptions } from "../options/index.js";

export const globalOptionSpecs = defineOptions(
  {
    key: "instanceDirectory",
    flags: ["--instance-dir <path>"],
    description: "Directory containing the muximo instance state and configuration.",
    exposure: "both",
    environment: {
      name: "MUXIMOD_INSTANCE_DIR",
      description: "Directory containing the muximo instance state and configuration.",
    },
    defaultValue: defaultMuximodInstanceDirectory,
    completion: { kind: "directory" },
  },
  {
    key: "verbose",
    flags: ["-v, --verbose"],
    description: "Show detailed diagnostics on the attached terminal.",
    exposure: "cli",
    defaultValue: false,
  },
);
