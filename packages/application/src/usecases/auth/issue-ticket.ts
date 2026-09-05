import { Effect } from "effect";
import type { MuximodAuthContext } from "../../ports/auth-types.js";
import { AuthClockService, AuthCryptoService, AuthWsTicketStoreService } from "./auth-services.js";

const WS_TICKET_TTL_MS = 30_000;

export const issueWebSocketTicket = Effect.fn("Auth.issueWebSocketTicket")(function* (
  context: MuximodAuthContext,
  endpoint: "terminal",
) {
  const crypto = yield* AuthCryptoService;
  const wsTickets = yield* AuthWsTicketStoreService;
  const clock = yield* AuthClockService;
  return yield* Effect.sync(() => {
    const ticket = crypto.randomOpaque(32);
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + WS_TICKET_TTL_MS).toISOString();
    wsTickets.put(crypto.hashOpaque(ticket), { sessionId: context.sessionId, endpoint, expiresAt });
    return { ticket, endpoint, expiresAt };
  });
});
