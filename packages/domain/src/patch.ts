export const clearPatch = { kind: "clear" } as const;
export type ClearPatch = typeof clearPatch;

/** An omitted value keeps the current value; clearPatch removes it. */
export type Patch<T> = T | ClearPatch | undefined;

export function applyPatch<T>(current: T | undefined, input: Patch<T>): T | undefined {
  if (input === undefined) return current;
  return input === clearPatch ? undefined : input as T;
}

export type ObjectPatch<T extends object> = {
  [Key in keyof T]?: T[Key] | ClearPatch;
};

export function applyObjectPatch<T extends object>(entity: T, input: ObjectPatch<T>): T {
  const next = { ...entity } as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    const value = input[key as keyof T];
    if (value === undefined) continue;
    if (value === clearPatch) delete next[key];
    else next[key] = value;
  }
  return next as T;
}
