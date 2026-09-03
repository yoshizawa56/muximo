import type { ApplicationEffect } from "../effect.js";
import type { ApprovedDevice, PairDeviceInput, PairingClaim, PairingOffer } from "./pairing-types.js";

export type { ApprovedDevice, PairDeviceInput, PairingClaim, PairingOffer } from "./pairing-types.js";

export interface PairingControlPort {
  createPairing(input: PairDeviceInput): ApplicationEffect<PairingOffer>;
  waitForClaim(pairingId: string): ApplicationEffect<PairingClaim>;
  approvePairing(pairingId: string): ApplicationEffect<ApprovedDevice>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
}

export interface PairingPresenterPort {
  showPairing(offer: PairingOffer): ApplicationEffect<void>;
  confirmPairing(claim: PairingClaim): ApplicationEffect<boolean>;
}
