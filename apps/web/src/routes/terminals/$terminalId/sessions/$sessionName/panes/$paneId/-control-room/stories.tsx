import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyPanes } from "../../../../../../-story-fixtures";
import type { CustomKeyboardSettingsViewModel, CustomKeyboardViewModel } from "../-custom-keyboard/viewmodel";
import { defaultCustomKeyboardButtons } from "../-custom-keyboard/viewmodel";
import type { PaneBoardViewModel } from "../-pane-board/viewmodel";
import type { PaneViewModel } from "../-terminal/viewmodel";
import { ControlRoomView } from "./view";
import type { ControlRoomViewModel } from "./viewmodel";

function createPaneBoard(overrides: Partial<PaneBoardViewModel> = {}): PaneBoardViewModel {
  return {
    selectedTarget: "%0",
    panes: storyPanes,
    status: "ready",
    errorMessage: null,
    select: fn(),
    refresh: fn(),
    ...overrides,
  };
}

function createTerminal(overrides: Partial<PaneViewModel> = {}): PaneViewModel {
  return {
    target: "%0",
    status: "connected",
    errorMessage: null,
    actionErrorMessage: null,
    viewportOwner: "mobile",
    viewportReason: "manual claim",
    pasteState: "idle",
    terminalContainerRef: () => undefined,
    reconnect: fn(),
    claim: fn(),
    detach: fn(),
    sendInput: fn(),
    focus: fn(),
    blur: fn(),
    keepNativeKeyboardOpen: fn(),
    toggleNativeKeyboard: fn(),
    nativeKeyboardVisible: false,
    pasteImage: fn(),
    enterCopyMode: fn(),
    pasteFromClipboard: fn(async () => undefined),
    pasteFromTmuxBuffer: fn(),
    ...overrides,
  };
}

function createKeyboard(overrides: Partial<CustomKeyboardViewModel> = {}): CustomKeyboardViewModel {
  return {
    buttons: defaultCustomKeyboardButtons,
    activeModifiers: [],
    nativeKeyboardVisible: false,
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
    onButtonPress: fn(),
    onDirectionalFlick: fn(),
    onNativeAction: fn(),
    onTerminalAction: fn(),
    onNativeFileSelected: fn(),
    onKeepNativeKeyboardOpen: fn(),
    onToggleNativeKeyboard: fn(),
    ...overrides,
  };
}

function createKeyboardSettings(): CustomKeyboardSettingsViewModel {
  return {
    buttons: defaultCustomKeyboardButtons,
    availableButtons: [],
    shortcutButtons: [],
    selectedButtonIds: [],
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
    onDrop: fn(),
    onRemoveButton: fn(),
    onRegisterShortcut: fn(),
    onUpdateShortcut: fn(),
    onDeleteShortcut: fn(),
    onRepeatStartDelayChange: fn(),
    onRepeatIntervalChange: fn(),
  };
}

function buildViewModel(overrides: Partial<ControlRoomViewModel> = {}): ControlRoomViewModel {
  return {
    terminal: createTerminal(),
    keyboard: createKeyboard(),
    keyboardSettings: createKeyboardSettings(),
    paneBoard: createPaneBoard(),
    onSessionSelect: fn(),
    onNewPane: fn(),
    ...overrides,
  };
}

const controlRoomScenarios = {
  connectedIdle: () =>
    buildViewModel({
      terminal: createTerminal({ target: "%1" }),
      paneBoard: createPaneBoard({
        selectedTarget: "%1",
        panes: storyPanes.filter((pane) => pane.state === "running"),
      }),
    }),
  waitingPanes: () => buildViewModel(),
  connectingTerminal: () =>
    buildViewModel({ terminal: createTerminal({ status: "connecting", viewportReason: null }) }),
  closedTerminal: () => buildViewModel({ terminal: createTerminal({ status: "closed", viewportReason: null }) }),
  shellPane: () =>
    buildViewModel({
      terminal: createTerminal({ target: "%2" }),
      paneBoard: createPaneBoard({
        selectedTarget: "%2",
        panes: storyPanes.filter((pane) => pane.hostPaneId === "%2"),
      }),
    }),
  desktopOwnsViewport: () =>
    buildViewModel({
      terminal: createTerminal({ viewportOwner: "desktop", viewportReason: "desktop activity detected" }),
    }),
  connectionError: () =>
    buildViewModel({
      terminal: createTerminal({ status: "error", errorMessage: "Terminal WebSocket closed unexpectedly" }),
    }),
  terminalActionError: () =>
    buildViewModel({ terminal: createTerminal({ actionErrorMessage: "tmux copy mode is unavailable" }) }),
  pastingImage: () => buildViewModel({ terminal: createTerminal({ pasteState: "pasting" }) }),
  imagePasted: () => buildViewModel({ terminal: createTerminal({ pasteState: "pasted" }) }),
  imagePasteFailed: () => buildViewModel({ terminal: createTerminal({ pasteState: "failed" }) }),
  standardKeyboardOpen: () => buildViewModel({ keyboard: createKeyboard({ nativeKeyboardVisible: true }) }),
  loadingPanes: () => buildViewModel({ paneBoard: createPaneBoard({ panes: [], status: "loading" }) }),
  paneListError: () =>
    buildViewModel({
      paneBoard: createPaneBoard({ panes: [], status: "error", errorMessage: "Unable to load panes" }),
    }),
  emptyPaneList: () => buildViewModel({ paneBoard: createPaneBoard({ panes: [] }) }),
  missingSelectedPane: () =>
    buildViewModel({
      terminal: createTerminal({ target: "" }),
      paneBoard: createPaneBoard({ panes: [], selectedTarget: "" }),
    }),
} satisfies Record<string, () => ControlRoomViewModel>;

function InteractiveControlRoomStory() {
  const [paneId, setPaneId] = useState("pane-review");

  return (
    <div className="relative min-h-screen">
      <button
        className="absolute top-2 left-2 z-[60] rounded bg-white px-2 py-1 text-xs text-black shadow"
        type="button"
        onClick={() => setPaneId((current) => (current === "pane-review" ? "pane-build" : "pane-review"))}
      >
        Switch pane route
      </button>
      <ControlRoomView paneId={paneId} viewModel={controlRoomScenarios.connectedIdle()} />
    </div>
  );
}

const meta = {
  title: "Pages/Control room",
  component: ControlRoomView,
  args: { paneId: "pane-review" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ControlRoomView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedWithWindowMap: Story = {
  args: { viewModel: controlRoomScenarios.waitingPanes() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /open tmux window map/i }));
    await userEvent.click(canvas.getByRole("tab", { name: /muximo 1/ }));
    await userEvent.click(canvas.getByRole("button", { name: /close window map/i }));
    await expect(canvas.getByRole("button", { name: /open tmux window map/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  },
};

export const ConnectedIdle: Story = {
  args: { viewModel: controlRoomScenarios.connectedIdle() },
};

export const WaitingPanes: Story = {
  args: { viewModel: controlRoomScenarios.waitingPanes() },
};

export const ConnectingTerminal: Story = {
  args: { viewModel: controlRoomScenarios.connectingTerminal() },
};

export const ClosedTerminal: Story = {
  args: { viewModel: controlRoomScenarios.closedTerminal() },
};

export const ShellPane: Story = {
  args: { viewModel: controlRoomScenarios.shellPane() },
};

export const DesktopOwnsViewport: Story = {
  args: { viewModel: controlRoomScenarios.desktopOwnsViewport() },
};

export const ConnectionError: Story = {
  args: { viewModel: controlRoomScenarios.connectionError() },
};

export const TerminalActionError: Story = {
  args: { viewModel: controlRoomScenarios.terminalActionError() },
};

export const PastingImage: Story = {
  args: { viewModel: controlRoomScenarios.pastingImage() },
};

export const ImagePasted: Story = {
  args: { viewModel: controlRoomScenarios.imagePasted() },
};

export const ImagePasteFailed: Story = {
  args: { viewModel: controlRoomScenarios.imagePasteFailed() },
};

export const StandardKeyboardOpen: Story = {
  args: { viewModel: controlRoomScenarios.standardKeyboardOpen() },
};

export const LoadingPanes: Story = {
  args: { viewModel: controlRoomScenarios.loadingPanes() },
};

export const PaneListError: Story = {
  args: { viewModel: controlRoomScenarios.paneListError() },
};

export const EmptyPaneList: Story = {
  args: { viewModel: controlRoomScenarios.emptyPaneList() },
};

export const MissingSelectedPane: Story = {
  args: { viewModel: controlRoomScenarios.missingSelectedPane() },
};

export const WindowMapError: Story = {
  args: { viewModel: controlRoomScenarios.paneListError() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /open tmux window map/i }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Unable to load panes");
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(args.viewModel.paneBoard.refresh).toHaveBeenCalledTimes(1);
  },
};

export const KeyboardSettings: Story = {
  args: { viewModel: controlRoomScenarios.connectedIdle() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open custom keyboard settings" }));
    await expect(canvas.getByRole("heading", { name: "Keyboard settings" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save" }));
    await expect(canvas.queryByRole("heading", { name: "Keyboard settings" })).not.toBeInTheDocument();
  },
};

export const KeyboardSettingsClose: Story = {
  args: { viewModel: controlRoomScenarios.connectedIdle() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open custom keyboard settings" }));
    await expect(canvas.getByRole("heading", { name: "Keyboard settings" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Close custom keyboard settings" }));
    await expect(canvas.queryByRole("heading", { name: "Keyboard settings" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Open custom keyboard settings" })).toBeVisible();
  },
};

export const PaneRouteChangeResetsLocalState: Story = {
  args: { viewModel: controlRoomScenarios.connectedIdle() },
  render: () => <InteractiveControlRoomStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /open tmux window map/i }));
    await expect(canvas.getByRole("button", { name: /close tmux window map/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Switch pane route" }));
    await expect(canvas.getByRole("button", { name: /open tmux window map/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    await userEvent.click(canvas.getByRole("button", { name: "Open custom keyboard settings" }));
    await expect(canvas.getByRole("heading", { name: "Keyboard settings" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Switch pane route" }));
    await expect(canvas.queryByRole("heading", { name: "Keyboard settings" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Open custom keyboard settings" })).toBeVisible();
  },
};
