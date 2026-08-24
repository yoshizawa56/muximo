/** Control-channel failures carry a stable machine-readable code. */
export function controlFailure(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
