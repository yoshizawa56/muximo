import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { ApprovedDevice, PairDeviceInput, PairingClaim, PairingOffer } from "../../ports/pairing-types.js";

export interface PairingControl {
  createPairing(input: PairDeviceInput): ApplicationEffect<PairingOffer>;
  waitForClaim(pairingId: string): ApplicationEffect<PairingClaim>;
  approvePairing(pairingId: string): ApplicationEffect<ApprovedDevice>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
}

export interface PairingPresenter {
  showPairing(offer: PairingOffer): ApplicationEffect<void>;
  confirmPairing(claim: PairingClaim): ApplicationEffect<boolean>;
}

/** Pairing control-channel capability. */
export class PairingControlService extends Context.Service<PairingControlService, PairingControl>()(
  "@muximo/application/PairingControl",
) {}

/** Pairing presentation capability. */
export class PairingPresenterService extends Context.Service<PairingPresenterService, PairingPresenter>()(
  "@muximo/application/PairingPresenter",
) {}

/** Services required by the pair-device use case. */
export type PairingServices = PairingControlService | PairingPresenterService;

export const pairingControlLayer = (control: PairingControl): Layer.Layer<PairingControlService> =>
  Layer.succeed(PairingControlService, control);

export const pairingPresenterLayer = (presenter: PairingPresenter): Layer.Layer<PairingPresenterService> =>
  Layer.succeed(PairingPresenterService, presenter);

/** Assembles pairing services from concrete implementations. */
export const pairingLayer = (dependencies: {
  control: PairingControl;
  presenter: PairingPresenter;
}): Layer.Layer<PairingServices> =>
  Layer.mergeAll(pairingControlLayer(dependencies.control), pairingPresenterLayer(dependencies.presenter));
