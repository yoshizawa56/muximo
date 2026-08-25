export function cameraErrorName(cause: unknown): string {
  return isRecord(cause) ? (readString(cause.name) ?? "") : "";
}

export function appendCameraErrorDetails(message: string, cause: unknown): string {
  const details = cameraErrorDetails(cause);
  return details ? `${message} Details: ${details}` : message;
}

export function cameraErrorDetails(cause: unknown): string | null {
  if (typeof cause === "string") return readString(cause);
  if (cause == null) return null;

  if (isRecord(cause)) {
    const name = readString(cause.name);
    const message = readString(cause.message);
    if (name && message) return `${name}: ${message}`;
    if (message || name) return message ?? name ?? null;

    try {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      return null;
    }
    return null;
  }

  const details = String(cause).trim();
  return details || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
