import { Effect } from "effect";
import { AuthClockService, AuthCryptoService, AuthStoreService, AuthWsTicketStoreService } from "./auth-services.js";
import { contextForSession } from "./device-guard.js";

export const consumeWebSocketTicket = Effect.fn("Auth.consumeWebSocketTicket")(function* (
  ticket: string | undefined,
  endpoint: "terminal",
) {
  const store = yield* AuthStoreService;
  const crypto = yield* AuthCryptoService;
  const wsTickets = yield* AuthWsTicketStoreService;
  const clock = yield* AuthClockService;
  if (!ticket) return undefined;
  const nowIso = clock.now().toISOString();
  const pending = wsTickets.take(crypto.hashOpaque(ticket));
  if (!pending || pending.endpoint !== endpoint || pending.expiresAt <= nowIso) return undefined;
  const session = yield* store.findSessionById(pending.sessionId);
  return session ? yield* contextForSession(session) : undefined;
});
