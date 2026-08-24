import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SettingsView } from "./-settings-view";
import type { SettingsViewModel } from "./-settings-viewmodel";

const appInfo = { version: "0.1.0", build: "storybook" };

function buildViewModel(overrides: Partial<SettingsViewModel> = {}): SettingsViewModel {
  return {
    appInfo,
    hasSavedProfile: false,
    isScanningQr: false,
    isPairingQr: false,
    pairingMessage: null,
    errorMessage: null,
    onClear: fn(),
    onBack: fn(),
    onOpenQrScanner: fn(),
    onCloseQrScanner: fn(),
    onQrValue: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Settings",
  component: SettingsView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstPairing: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /scan qr code/i }));
    await expect(args.viewModel.onOpenQrScanner).toHaveBeenCalledOnce();
  },
};

export const SavedConnection: Story = {
  args: { viewModel: buildViewModel({ hasSavedProfile: true }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /forget saved connection/i }));
    await expect(args.viewModel.onClear).toHaveBeenCalledOnce();
  },
};

export const InvalidPairingCode: Story = {
  args: { viewModel: buildViewModel({ errorMessage: "QR code does not contain a valid muximo pairing code" }) },
};

export const PairingInProgress: Story = {
  args: {
    viewModel: buildViewModel({
      isPairingQr: true,
      pairingMessage: "Waiting for approval from muximod…",
    }),
  },
};
