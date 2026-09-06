import { z } from "zod";
import { allowsOrigin, corsResponse, errorBody, MuximodHttpError, originDeniedResponse } from "./middleware.js";
import type { MuximodHookEvent, MuximodHttpDependencies } from "./types.js";
import { readCappedRequestBody } from "./web-proxy.js";

/** tmux hook posts are tiny form fields; reject anything larger before parsing. */
const maxTmuxHookBodyBytes = 64 * 1024;

export async function handleTmuxHook(request: Request, deps: MuximodHttpDependencies): Promise<Response> {
  if (request.method !== "POST") return corsResponse(undefined, request, deps.originPolicy, 405);
  if (!allowsOrigin(request, deps.originPolicy)) return originDeniedResponse();
  if (request.headers.get("x-muximod-hook-token") !== deps.hookToken) {
    return corsResponse(
      errorBody(new MuximodHttpError(401, "unauthorized", "Invalid tmux hook token")),
      request,
      deps.originPolicy,
      401,
    );
  }
  // Cap the body while reading so a missing or lying Content-Length cannot
  // push an unbounded payload into the form parser.
  const rawBody = await readCappedRequestBody(request, maxTmuxHookBodyBytes);
  if (rawBody === undefined) {
    return corsResponse(
      { error: "invalid_request", message: "tmux hook request body is too large" },
      request,
      deps.originPolicy,
      413,
    );
  }
  const form = await parseHookForm(request, rawBody);
  const parsed = z
    .object({
      event: z.enum(["client-attached", "client-active", "client-resized", "client-focus-in", "client-detached"]),
      client: z.string().trim().min(1).max(256),
    })
    .strict()
    .safeParse({ event: form.get("event"), client: form.get("client") });
  if (!parsed.success)
    return corsResponse(
      { error: "invalid_request", message: "Request validation failed" },
      request,
      deps.originPolicy,
      400,
    );
  await deps.application.hooks.handleTerminalHostHook(parsed.data.event as MuximodHookEvent, parsed.data.client);
  return corsResponse(undefined, request, deps.originPolicy, 204);
}

async function parseHookForm(request: Request, rawBody: ArrayBuffer): Promise<FormData> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: rawBody }).formData();
}
