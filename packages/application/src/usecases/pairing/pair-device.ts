import { Effect } from "effect";
import type { PairDeviceInput, PairingControlPort, PairingPresenterPort } from "../../ports/pairing.js";

export type PairDeviceResult = { status: "approved"; deviceId: string } | { status: "rejected" };

/**
 * Coordinates the device-pairing workflow without knowing how the control
 * channel or the user's terminal is implemented.
 */
export class PairDevice {
  public constructor(
    private readonly control: PairingControlPort,
    private readonly presenter: PairingPresenterPort,
  ) {}

  public readonly execute = Effect.fn("Pairing.pairDevice")(
    { self: this },
    function* (this: PairDevice, input: PairDeviceInput) {
      const control = this.control;
      const presenter = this.presenter;
      const offer = yield* control.createPairing(input);
      yield* presenter.showPairing(offer);

      const claim = yield* control.waitForClaim(offer.pairingId);
      const approved = yield* presenter.confirmPairing(claim);
      if (!approved) {
        yield* control.rejectPairing(claim.pairingId);
        return { status: "rejected" } as const;
      }

      const device = yield* control.approvePairing(claim.pairingId);
      return { status: "approved", deviceId: device.deviceId } as const;
    },
  );
}
