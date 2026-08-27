import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
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
  keyboardSettingsOpen: boolean;
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
  const panesQuery = useQuery(
    resources.utils.panes.list.queryOptions({
      input: scopedSessionName ? { session: scopedSessionName } : {},
      enabled: Boolean(connection) && Boolean(sessionName),
      staleTime: 1_000,
    }),
  );
  const panes = panesQuery.data?.panes ?? [];
  const selectedPane = panes.find((pane) => pane.id === paneId) ?? null;
  const selectedTarget = selectedPane?.hostPaneId ?? "";
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
  const paneBoard = usePaneBoardViewModel({
    selectedTarget,
    sessionName,
    connection,
    utils: resources.utils,
    alwaysOpen: true,
    onSelect: (target) => {
      const pane = panes.find((candidate) => candidate.hostPaneId === target);
      if (pane)
        void navigate({
          to: "/terminals/$terminalId/sessions/$sessionName/panes/$paneId",
          params: { terminalId, sessionName, paneId: pane.id },
        });
    },
  });

  return {
    terminal,
    keyboard: keyboardController.keyboard,
    keyboardSettings: keyboardController.settings,
    keyboardSettingsOpen: keyboardController.settingsOpen,
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
