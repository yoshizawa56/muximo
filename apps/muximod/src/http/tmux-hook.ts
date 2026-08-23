import { z } from "zod";
import { corsResponse, errorBody, MuximodHttpError } from "./middleware.js";
import type { MuximodHookEvent, MuximodHttpDependencies } from "./types.js";

export async function handleTmuxHook(request: Request, deps: MuximodHttpDependencies): Promise<Response> {
  if (request.method !== "POST") return corsResponse(undefined, deps.corsOrigin, 405);
  if (request.headers.get("x-muximod-hook-token") !== deps.hookToken) {
    return corsResponse(
      errorBody(new MuximodHttpError(401, "unauthorized", "Invalid tmux hook token")),
      deps.corsOrigin,
      401,
    );
  }
  const form = await request.formData();
  const parsed = z
    .object({
      event: z.enum(["client-attached", "client-active", "client-resized", "client-focus-in", "client-detached"]),
      client: z.string().trim().min(1).max(256),
    })
    .strict()
    .safeParse({ event: form.get("event"), client: form.get("client") });
  if (!parsed.success)
    return corsResponse({ error: "invalid_request", message: "Request validation failed" }, deps.corsOrigin, 400);
  deps.application.hooks.handleTmux(parsed.data.event as MuximodHookEvent, parsed.data.client);
  return corsResponse(undefined, deps.corsOrigin, 204);
}
