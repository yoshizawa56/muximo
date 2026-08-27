import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyPanes } from "../../../../../../-story-fixtures";
import type { CustomKeyboardSettingsViewModel, CustomKeyboardViewModel } from "../-custom-keyboard/viewmodel";
import { defaultCustomKeyboardButtons } from "../-custom-keyboard/viewmodel";
import type { PaneBoardViewModel } from "../-pane-board/viewmodel";
import type { PaneViewModel } from "../-terminal/viewmodel";
import { ControlRoomView } from "./view";
import type { ControlRoomViewModel } from "./viewmodel";

function buildViewModel(overrides: Partial<ControlRoomViewModel> = {}): ControlRoomViewModel {
  const close = fn();
  const paneBoard: PaneBoardViewModel = {
    isOpen: true,
    selectedTarget: "%0",
    panes: storyPanes,
    status: "ready",
    errorMessage: null,
    open: fn(),
    close,
    toggle: fn(),
    select: fn(),
    refresh: fn(),
  };
  const terminal: PaneViewModel = {
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
  };
  const keyboard: CustomKeyboardViewModel = {
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
    onOpenSettings: fn(),
  };
  const keyboardSettings: CustomKeyboardSettingsViewModel = {
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
    onClose: fn(),
    onSave: fn(),
  };
  return {
    terminal,
    keyboard,
    keyboardSettings,
    keyboardSettingsOpen: false,
    paneBoard,
    onSessionSelect: fn(),
    onNewPane: fn(),
    ...overrides,
  };
}

const meta = {
  title: "Pages/Control room",
  component: ControlRoomView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ControlRoomView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConnectedWithWindowMap: Story = {
  args: { viewModel: buildViewModel() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: /muximo 1/ }));
    await userEvent.click(canvas.getByRole("button", { name: /close window map/i }));
    await expect(args.viewModel.paneBoard.close).toHaveBeenCalledOnce();
  },
};

export const DesktopOwnsViewport: Story = {
  args: {
    viewModel: buildViewModel({
      terminal: {
        ...buildViewModel().terminal,
        viewportOwner: "desktop",
        viewportReason: "desktop activity detected",
      },
    }),
  },
};

export const ConnectionError: Story = {
  args: {
    viewModel: buildViewModel({
      terminal: {
        ...buildViewModel().terminal,
        status: "error",
        errorMessage: "Terminal WebSocket closed unexpectedly",
      },
    }),
  },
};
