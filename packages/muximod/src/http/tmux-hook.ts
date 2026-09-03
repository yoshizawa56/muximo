import { Result, Schema } from "effect";
import { corsResponse, errorBody, MuximodHttpError } from "./middleware.js";
import type { MuximodHookEvent, MuximodHttpDependencies } from "./types.js";

const tmuxHookSchema = Schema.Struct({
  event: Schema.Literals(["client-attached", "client-active", "client-resized", "client-focus-in", "client-detached"]),
  client: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});

export async function handleTmuxHook(request: Request, deps: MuximodHttpDependencies): Promise<Response> {
  if (request.method !== "POST") return corsResponse(undefined, request, deps.originPolicy, 405);
  if (request.headers.get("x-muximod-hook-token") !== deps.hookToken) {
    return corsResponse(
      errorBody(new MuximodHttpError(401, "unauthorized", "Invalid tmux hook token")),
      request,
      deps.originPolicy,
      401,
    );
  }
  const form = await request.formData();
  const parsed = Schema.decodeUnknownResult(tmuxHookSchema, { onExcessProperty: "error" })({
    event: form.get("event"),
    client: form.get("client"),
  });
  if (Result.isFailure(parsed))
    return corsResponse(
      { error: "invalid_request", message: "Request validation failed" },
      request,
      deps.originPolicy,
      400,
    );
  await deps.application.hooks.handleTerminalHostHook(parsed.success.event as MuximodHookEvent, parsed.success.client);
  return corsResponse(undefined, request, deps.originPolicy, 204);
}
