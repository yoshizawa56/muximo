import { Effect } from "effect";
import type { AuthCryptoPort, AuthStorePort, AuthWsTicketStorePort, Clock } from "../../ports/auth.js";
import { contextForSession } from "./device-guard.js";

export const consumeWebSocketTicket = Effect.fn("Auth.consumeWebSocketTicket")(function* (
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; wsTickets: AuthWsTicketStorePort; clock: Clock },
  ticket: string | undefined,
  endpoint: "terminal",
) {
  if (!ticket) return undefined;
  const nowIso = deps.clock.now().toISOString();
  const pending = deps.wsTickets.take(deps.crypto.hashOpaque(ticket));
  if (!pending || pending.endpoint !== endpoint || pending.expiresAt <= nowIso) return undefined;
  const session = yield* deps.store.findSessionById(pending.sessionId);
  return session ? yield* contextForSession(deps.store, session) : undefined;
});
