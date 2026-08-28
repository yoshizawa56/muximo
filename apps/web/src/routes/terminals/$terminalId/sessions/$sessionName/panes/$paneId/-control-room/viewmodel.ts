import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { isMockMode } from "../../../../../../../../mock/mock-data";
import { muximoBridge } from "../../../../../../../../platform/muximo-bridge";
import { useTerminalResources } from "../../../../../../-terminal-resources";
import { encodeCustomKeyboardNativeInput, encodeCustomKeyboardSequence } from "../-custom-keyboard/input";
import {
  type CustomKeyboardTerminalAction,
  type CustomKeyboardTerminalActionHandlers,
  routeCustomKeyboardTerminalAction,
} from "../-custom-keyboard/terminal-actions";
import type {
  CustomKeyboardModifier,
  CustomKeyboardSettingsViewModel,
  CustomKeyboardViewModel,
} from "../-custom-keyboard/viewmodel";
import { useCustomKeyboardViewModel } from "../-custom-keyboard/viewmodel";
import type { PaneBoardViewModel } from "../-pane-board/viewmodel";
import { usePaneBoardViewModel } from "../-pane-board/viewmodel";
import type { PaneViewModel } from "../-terminal/viewmodel";
import { usePaneViewModel } from "../-terminal/viewmodel";

export type ControlRoomViewModel = {
  terminal: PaneViewModel;
  keyboard: CustomKeyboardViewModel;
  keyboardSettings: CustomKeyboardSettingsViewModel;
  paneBoard: PaneBoardViewModel;
  onSessionSelect: () => void;
  onNewPane: () => void;
};

export function useControlRoomViewModel(): ControlRoomViewModel {
  const navigate = useNavigate();
  const { terminalId, sessionName, paneId } = useParams({
    from: "/terminals/$terminalId/sessions/$sessionName/panes/$paneId/",
  });
  const resources = useTerminalResources({ terminalId, sessionName });
  const connection = resources.connection;
  const scopedSessionName = resources.selectedSession?.name ?? sessionName;
  const paneBoard = usePaneBoardViewModel({
    selectedPaneId: paneId,
    sessionName: scopedSessionName,
    connection,
    utils: resources.utils,
    pollWhenHidden: true,
    pollIntervalMs: isMockMode() ? 3_000 : 10_000,
    onSelect: (nextPaneId) => {
      void navigate({
        to: "/terminals/$terminalId/sessions/$sessionName/panes/$paneId",
        params: { terminalId, sessionName, paneId: nextPaneId },
      });
    },
  });
  const selectedPane = paneBoard.panes.find((pane) => pane.id === paneId) ?? null;
  const selectedTarget = paneBoard.selectedTarget;
  const [activeKeyboardModifiers, setActiveKeyboardModifiers] = useState<CustomKeyboardModifier[]>([]);
  const activeKeyboardModifiersRef = useRef<CustomKeyboardModifier[]>([]);
  const onNativeKeyboardInput = useCallback((data: string) => {
    const modifiers = activeKeyboardModifiersRef.current;
    if (modifiers.length === 0) return data;
    activeKeyboardModifiersRef.current = [];
    setActiveKeyboardModifiers([]);
    return encodeCustomKeyboardNativeInput(data, modifiers);
  }, []);
  const onActiveKeyboardModifiersChange = useCallback((modifiers: readonly CustomKeyboardModifier[]) => {
    const nextModifiers = [...modifiers];
    activeKeyboardModifiersRef.current = nextModifiers;
    setActiveKeyboardModifiers(nextModifiers);
  }, []);
  const terminal = usePaneViewModel({
    target: selectedTarget,
    connection,
    transformInput: onNativeKeyboardInput,
    suppressNativeTouch: selectedPane?.kind === "shell",
  });
  const onKeyboardSequence = useCallback(
    (
      sequence: Parameters<typeof encodeCustomKeyboardSequence>[0],
      activeModifiers: Parameters<typeof encodeCustomKeyboardSequence>[1],
    ) => {
      terminal.sendInput(encodeCustomKeyboardSequence(sequence, activeModifiers));
    },
    [terminal.sendInput],
  );
  const onKeyboardTerminalAction = useCallback(
    (action: CustomKeyboardTerminalAction) => {
      const handlers: CustomKeyboardTerminalActionHandlers = {
        "enter-copy-mode": terminal.enterCopyMode,
        "paste-from-clipboard": () => {
          void terminal.pasteFromClipboard();
        },
        "paste-from-tmux-buffer": terminal.pasteFromTmuxBuffer,
      };
      routeCustomKeyboardTerminalAction(action, handlers);
    },
    [terminal.enterCopyMode, terminal.pasteFromClipboard, terminal.pasteFromTmuxBuffer],
  );
  const keyboardController = useCustomKeyboardViewModel({
    nativeKeyboardVisible: terminal.nativeKeyboardVisible,
    activeModifiers: activeKeyboardModifiers,
    onActiveModifiersChange: onActiveKeyboardModifiersChange,
    onSequence: onKeyboardSequence,
    onTerminalAction: onKeyboardTerminalAction,
    onKeyEffect: muximoBridge.keyPressHaptic,
    onNativeFileSelected: (_action, file) => {
      terminal.pasteImage(file);
    },
    onKeepNativeKeyboardOpen: terminal.keepNativeKeyboardOpen,
    onNativeKeyboardToggle: terminal.toggleNativeKeyboard,
  });
  return {
    terminal,
    keyboard: keyboardController.keyboard,
    keyboardSettings: keyboardController.settings,
    paneBoard,
    onSessionSelect: () => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId } });
    },
    onNewPane: () => {
      void navigate({
        to: "/terminals/$terminalId/sessions/$sessionName/panes/new",
        params: { terminalId, sessionName },
      });
    },
  };
}
