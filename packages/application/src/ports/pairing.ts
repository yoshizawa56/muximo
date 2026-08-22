import type { ApprovedDevice, PairDeviceInput, PairingClaim, PairingOffer } from "../models/pairing.js";

export interface PairingControlPort {
  createPairing(input: PairDeviceInput): Promise<PairingOffer>;
  waitForClaim(pairingId: string): Promise<PairingClaim>;
  approvePairing(pairingId: string): Promise<ApprovedDevice>;
  rejectPairing(pairingId: string): Promise<void>;
}

export interface PairingPresenterPort {
  showPairing(offer: PairingOffer): Promise<void>;
  confirmPairing(claim: PairingClaim): Promise<boolean>;
}
