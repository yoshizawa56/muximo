export const allCliBuildModes = ["development", "production"] as const;

export type CliBuildMode = (typeof allCliBuildModes)[number];

export type CliCommandRegistration = {
  availableIn: readonly CliBuildMode[];
  register: () => void;
};

export function isAvailableIn(availableIn: readonly CliBuildMode[] | undefined, buildMode: CliBuildMode): boolean {
  return availableIn === undefined || availableIn.includes(buildMode);
}
