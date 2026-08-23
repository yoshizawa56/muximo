import type { AuthCryptoPort, AuthStorePort, AuthWsTicketStorePort } from "../../ports/auth.js";
import type { MuximodAuthContext } from "../../ports/auth-types.js";
import { contextForSession } from "./device-guard.js";

export function consumeWebSocketTicket(
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; wsTickets: AuthWsTicketStorePort; now?: () => Date },
  ticket: string | undefined,
  endpoint: "terminal",
): MuximodAuthContext | null {
  if (!ticket) return null;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const pending = deps.wsTickets.take(deps.crypto.hashOpaque(ticket));
  if (!pending || pending.endpoint !== endpoint || pending.expiresAt <= nowIso) return null;
  const session = deps.store.findSessionById(pending.sessionId);
  return session ? contextForSession(deps.store, session) : null;
}
