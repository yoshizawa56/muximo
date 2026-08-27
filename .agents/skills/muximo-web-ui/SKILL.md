---
name: muximo-web-ui
description: Apply when modifying the Muximo Web UI, including routes, features, routing, ViewModels, React Query state, or xterm.js integration. Enforce Muximo's URL-driven navigation, route/ViewModel/View separation, and server-state versus terminal-transport boundaries.
---

# Muximo Web UI

Use this skill only for Web UI changes under `apps/web/src`.

## Rules

- TanStack Router URLs are the source of truth for navigation and resource selection. Do not add a product-wide stage/state machine that duplicates the route tree.
- Keep route adapters, route ViewModels, and Views separate: route files read router state, ViewModels compose behavior and state, and Views render from props plus presentation-local state.
- Treat the ViewModel interface as the View's scenario boundary. The View owns only presentation-local state and transitions, such as tabs, modal visibility, drag and hover state, focus, and transient drafts. These transitions must not contain business rules, persistence, shared semantics, or external effects.
- The ViewModel owns application semantics and coordination: server, shared, and persisted state; route and resource selection; terminal transport; external effects; and intent-oriented commands. Expose state and intents instead of generic setters that merely mirror View internals.
- It is valid to put most application behavior behind the ViewModel boundary so that a View can be rendered from a complete, deterministic fixture. Do not move presentation-local state into a production ViewModel solely to make stories easier to write.
- Keep route-specific composition beside its route. Move code into `features/` only when it is genuinely shared by independent routes.
- Use TanStack Query for server state such as panes, sessions, workspaces, and mutations. Do not store terminal bytes, WebSocket lifecycle, connection state, or xterm instances in the Query cache.
- Query and mutation keys are derived from the oRPC contract through `@orpc/tanstack-query` utilities (`app/api/orpc-utils.ts`); never write query key arrays by hand. Reads use `utils.<group>.<procedure>.queryOptions(...)`, imperative writes use `utils.<group>.<procedure>.call(...)` plus invalidation helpers.
- Cache invalidation goes only through `app/api/invalidation.ts`. It maps causes (SSE events, reconnects, mutation success) to contract resource groups using subtree-level partial keys, and its resource-group list is type-checked against the contract so a new group cannot be added without acknowledging it here.
- Keep terminal transport lifecycle in the relevant ViewModel or terminal feature. Treat the HTTP API, event invalidation stream, and terminal WebSocket as separate concerns.
- Stable Muximo pane IDs may appear in routes; do not use volatile tmux pane targets as the Web navigation identity.

## Story coverage

- Define stories by meaningful ViewModel scenarios, not by every possible field-value combination. Add a named scenario when ViewModel output creates a distinct View branch or user-visible state, and keep the scenario catalog typed and reusable.
- Use Storybook `play` functions to exercise real View-local transitions through user interactions, including modal, tab, draft, drag-and-drop, shortcut-editing, and focus behavior. A callback spy alone verifies invocation, not the resulting UI behavior.
- When a `play` interaction must change supplied ViewModel output, use a stateful story harness that updates the fixture; do not weaken the production boundary to accommodate a static story fixture.
- Stories cover View rendering and interaction at the ViewModel boundary. Test pure policies and transforms, terminal schedulers, storage migrations, and external transport or bridge behavior with focused unit or integration tests; stories may provide their observable outcomes as fixtures.

When changing a convention, inspect the neighboring route and feature tests/stories and update the affected behavior rather than adding a parallel pattern.
