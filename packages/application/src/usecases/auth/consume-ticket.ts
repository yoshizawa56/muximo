import type { AuthCryptoPort, AuthStorePort, AuthWsTicketStorePort, Clock } from "../../ports/auth.js";
import type { MuximodAuthContext } from "../../ports/auth-types.js";
import { contextForSession } from "./device-guard.js";

export async function consumeWebSocketTicket(
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; wsTickets: AuthWsTicketStorePort; clock: Clock },
  ticket: string | undefined,
  endpoint: "terminal",
): Promise<MuximodAuthContext | undefined> {
  if (!ticket) return undefined;
  const nowIso = deps.clock.now().toISOString();
  const pending = deps.wsTickets.take(deps.crypto.hashOpaque(ticket));
  if (!pending || pending.endpoint !== endpoint || pending.expiresAt <= nowIso) return undefined;
  const session = await deps.store.findSessionById(pending.sessionId);
  return session ? contextForSession(deps.store, session) : undefined;
}
