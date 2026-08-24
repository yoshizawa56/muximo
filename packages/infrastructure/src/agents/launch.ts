import { accessSync, constants } from "node:fs";

/** Resolves an executable while preserving the host's PATH and explicit paths. */
export function resolveExecutable(value: string, environment: NodeJS.ProcessEnv): string {
  if (value.includes("/")) {
    accessSync(value, constants.X_OK);
    return value;
  }
  const path = (environment.PATH ?? "").split(":").find((directory) => {
    try {
      accessSync(`${directory}/${value}`, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!path) throw new Error(`backend executable not found: ${value}`);
  return `${path}/${value}`;
}
