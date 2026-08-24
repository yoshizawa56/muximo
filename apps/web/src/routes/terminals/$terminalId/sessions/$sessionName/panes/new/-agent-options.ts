import type { CreatePaneRequest } from "@muximo/contract";

export type NewPaneAgent = Exclude<CreatePaneRequest["agentId"], null>;

/** Provider values are derived from the contract; labels and presentation stay Web-owned. */
export const agentOptions = [
  {
    value: "codex",
    label: "Codex",
    monogram: "C",
    badgeClass: "border-[#2b6f8a] bg-[rgb(21_94_117_/_24%)] text-[#7dd3fc]",
  },
  {
    value: "claude",
    label: "Claude",
    monogram: "C",
    badgeClass: "border-[#9a5b3c] bg-[rgb(154_52_18_/_22%)] text-[#fdba74]",
  },
  {
    value: "opencode",
    label: "OpenCode",
    monogram: "O",
    badgeClass: "border-[#3d8b4c] bg-[rgb(57_214_91_/_14%)] text-lime",
  },
] as const satisfies readonly {
  value: NewPaneAgent;
  label: string;
  monogram: string;
  badgeClass: string;
}[];
