import { Effect } from "effect";
import type { AuthCryptoPort, AuthWsTicketStorePort, Clock } from "../../ports/auth.js";
import type { MuximodAuthContext } from "../../ports/auth-types.js";

const WS_TICKET_TTL_MS = 30_000;

export const issueWebSocketTicket = Effect.fn("Auth.issueWebSocketTicket")(function* (
  deps: { crypto: AuthCryptoPort; wsTickets: AuthWsTicketStorePort; clock: Clock },
  context: MuximodAuthContext,
  endpoint: "terminal",
) {
  return yield* Effect.sync(() => {
    const ticket = deps.crypto.randomOpaque(32);
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + WS_TICKET_TTL_MS).toISOString();
    deps.wsTickets.put(deps.crypto.hashOpaque(ticket), { sessionId: context.sessionId, endpoint, expiresAt });
    return { ticket, endpoint, expiresAt };
  });
});
