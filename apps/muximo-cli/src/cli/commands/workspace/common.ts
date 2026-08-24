type OptionValues = Record<string, unknown>;

export function firstString(options: OptionValues, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function firstBooleanOrString(
  options: OptionValues,
  positiveKeys: readonly string[],
  negativeKeys: readonly string[],
): { value?: string | null; explicit: boolean } {
  for (const key of positiveKeys) {
    const value = options[key];
    if (typeof value === "string") return { value, explicit: true };
    if (value === false) return { value: null, explicit: true };
  }
  if (positiveKeys.some((key) => options[key] === false) || negativeKeys.some((key) => options[key] === false)) {
    return { value: null, explicit: true };
  }
  return { explicit: false };
}

export function mergeStringArrays(options: OptionValues, keys: readonly string[]): string[] {
  return keys.flatMap((key) => (Array.isArray(options[key]) ? options[key] : []));
}
