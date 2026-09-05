import { Effect } from "effect";
import type { PairDeviceInput } from "../../ports/pairing.js";
import { PairingControlService, PairingPresenterService } from "./pairing-services.js";

export type PairDeviceResult = { status: "approved"; deviceId: string } | { status: "rejected" };

/**
 * Coordinates the device-pairing workflow without knowing how the control
 * channel or the user's terminal is implemented.
 */
export class PairDevice {
  public readonly execute = Effect.fn("Pairing.pairDevice")(
    { self: this },
    function* (this: PairDevice, input: PairDeviceInput) {
      const control = yield* PairingControlService;
      const presenter = yield* PairingPresenterService;
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
