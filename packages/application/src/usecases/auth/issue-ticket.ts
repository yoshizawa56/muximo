import type { AuthCryptoPort, AuthWsTicketStorePort } from "../../ports/auth.js";
import type { MuximodAuthContext, WsTicketResponse } from "../../ports/auth-types.js";

const WS_TICKET_TTL_MS = 30_000;

export function issueWebSocketTicket(
  deps: { crypto: AuthCryptoPort; wsTickets: AuthWsTicketStorePort; now?: () => Date },
  context: MuximodAuthContext,
  endpoint: "terminal",
): WsTicketResponse {
  const ticket = deps.crypto.randomOpaque(32);
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + WS_TICKET_TTL_MS).toISOString();
  deps.wsTickets.put(deps.crypto.hashOpaque(ticket), { sessionId: context.sessionId, endpoint, expiresAt });
  return { ticket, endpoint, expiresAt };
}
