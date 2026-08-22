// This adapter wires application authentication to the infrastructure crypto implementation.
import {
  AuthService as ApplicationAuthService,
  type AuthServiceOptions as ApplicationAuthServiceOptions,
  type MuximodAuthContext,
} from "@muximo/application";
import { nodeAuthCrypto } from "./crypto.js";

export type AuthServiceOptions = Omit<ApplicationAuthServiceOptions, "crypto"> & {
  crypto?: ApplicationAuthServiceOptions["crypto"];
};
export type AuthContext = MuximodAuthContext;
export type { AuthPairingClaimNotification } from "@muximo/application";

/** Composition adapter that supplies the host crypto implementation. */
export class AuthService extends ApplicationAuthService {
  public constructor(options: AuthServiceOptions) {
    super({ ...options, crypto: options.crypto ?? nodeAuthCrypto });
  }
}
