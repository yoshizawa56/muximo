---
name: muximo-web-ui
description: Apply when modifying the Muximo Web UI, including routes, features, routing, ViewModels, React Query state, or xterm.js integration. Enforce Muximo's URL-driven navigation, route/ViewModel/View separation, and server-state versus terminal-transport boundaries.
---

# Muximo Web UI

Use this skill only for Web UI changes under `apps/web/src`.

## Rules

- TanStack Router URLs are the source of truth for navigation and resource selection. Do not add a product-wide stage/state machine that duplicates the route tree.
- Keep route adapters, route ViewModels, and Views separate: route files read router state, ViewModels compose behavior and state, and Views render from props.
- Keep route-specific composition beside its route. Move code into `features/` only when it is genuinely shared by independent routes.
- Use TanStack Query for server state such as panes, sessions, workspaces, and mutations. Do not store terminal bytes, WebSocket lifecycle, connection state, or xterm instances in the Query cache.
- Query and mutation keys are derived from the oRPC contract through `@orpc/tanstack-query` utilities (`app/api/orpc-utils.ts`); never write query key arrays by hand. Reads use `utils.<group>.<procedure>.queryOptions(...)`, imperative writes use `utils.<group>.<procedure>.call(...)` plus invalidation helpers.
- Cache invalidation goes only through `app/api/invalidation.ts`. It maps causes (SSE events, reconnects, mutation success) to contract resource groups using subtree-level partial keys, and its resource-group list is type-checked against the contract so a new group cannot be added without acknowledging it here.
- Keep terminal transport lifecycle in the relevant ViewModel or terminal feature. Treat the HTTP API, event invalidation stream, and terminal WebSocket as separate concerns.
- Stable Muximo pane IDs may appear in routes; do not use volatile tmux pane targets as the Web navigation identity.

When changing a convention, inspect the neighboring route and feature tests/stories and update the affected behavior rather than adding a parallel pattern.
