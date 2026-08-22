import type {
  PairDeviceInput,
  PairDeviceResult,
} from "../../models/pairing.js";
import type {
  PairingControlPort,
  PairingPresenterPort,
} from "../../ports/pairing.js";

/**
 * Coordinates the device-pairing workflow without knowing how the control
 * channel or the user's terminal is implemented.
 */
export class PairDevice {
  public constructor(
    private readonly control: PairingControlPort,
    private readonly presenter: PairingPresenterPort,
  ) {}

  public async execute(input: PairDeviceInput): Promise<PairDeviceResult> {
    const offer = await this.control.createPairing(input);
    await this.presenter.showPairing(offer);

    const claim = await this.control.waitForClaim(offer.pairingId);
    const approved = await this.presenter.confirmPairing(claim);
    if (!approved) {
      await this.control.rejectPairing(claim.pairingId);
      return { status: "rejected" };
    }

    const device = await this.control.approvePairing(claim.pairingId);
    return { status: "approved", deviceId: device.deviceId };
  }
}
