import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { BrowserPairingPreview } from "../../app/api/browser-auth";
import type { BrowserConnectionProfile } from "../../app/api/connection-profile-store";
import { SettingsView } from "./-settings-view";
import type { SettingsViewModel } from "./-settings-viewmodel";

const appInfo = { version: "0.1.0", build: "storybook" };
const storyProfiles: BrowserConnectionProfile[] = [
  {
    id: "server-feature-123456",
    name: "feature-login",
    muximodBaseUrl: "http://127.0.0.1:4318",
    serverId: "server-feature-123456",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
  {
    id: "server-staging-123456",
    name: "staging",
    muximodBaseUrl: "https://staging.example.ts.net",
    serverId: "server-staging-123456",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
];
const pairingPreview: BrowserPairingPreview = {
  muximodBaseUrl: "http://127.0.0.1:4318",
  serverId: "server-feature-123456",
};

function buildViewModel(overrides: Partial<SettingsViewModel> = {}): SettingsViewModel {
  return {
    appInfo,
    profiles: [],
    activeProfileId: null,
    isScanningQr: false,
    isPreparingPairing: false,
    pairingPreview: null,
    pairingName: "",
    isPairingQr: false,
    pairingMessage: null,
    errorMessage: null,
    editingProfileId: null,
    editingProfileName: "",
    onBack: fn(),
    onOpenQrScanner: fn(),
    onCloseQrScanner: fn(),
    onQrValue: fn(),
    onPairingNameChange: fn(),
    onConfirmPairing: fn(),
    onCancelPairing: fn(),
    onSelectProfile: fn(),
    onRemoveProfile: fn(),
    onStartRename: fn(),
    onRenameChange: fn(),
    onCancelRename: fn(),
    onSaveRename: fn(),
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

export const SavedConnections: Story = {
  args: { viewModel: buildViewModel({ profiles: storyProfiles, activeProfileId: storyProfiles[0].id }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /rename/i }));
    await expect(args.viewModel.onStartRename).toHaveBeenCalledWith(storyProfiles[0].id);
  },
};

export const PairingConfirmation: Story = {
  args: {
    viewModel: buildViewModel({
      pairingPreview,
      pairingName: "feature-login",
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /connect/i }));
    await expect(args.viewModel.onConfirmPairing).toHaveBeenCalledOnce();
  },
};

export const InvalidPairingCode: Story = {
  args: { viewModel: buildViewModel({ errorMessage: "QR code does not contain a valid muximo pairing code" }) },
};

export const MuximodConnectionFailed: Story = {
  args: {
    viewModel: buildViewModel({
      errorMessage:
        "Could not communicate with muximod while requesting server information.\nEndpoint: https://muximo-host.tailnet.ts.net:8444/rpc\nDetails: TypeError: Load failed",
    }),
  },
};

export const PairingCheckInProgress: Story = {
  args: {
    viewModel: buildViewModel({
      isPreparingPairing: true,
      pairingMessage: "Checking QR code…",
    }),
  },
};

export const PairingInProgress: Story = {
  args: {
    viewModel: buildViewModel({
      isPairingQr: true,
      pairingMessage: "Waiting for approval from muximod…",
    }),
  },
};
