import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTerminalResources } from "../../../../../-terminal-resources";
import { encodeCustomKeyboardSequence } from "./-custom-keyboard-input";
import type {
  CustomKeyboardFlickPreview,
  CustomKeyboardSettingsViewModel,
  CustomKeyboardViewModel,
} from "./-custom-keyboard-viewmodel";
import { useCustomKeyboardViewModel } from "./-custom-keyboard-viewmodel";
import type { PaneBoardViewModel } from "./-pane-board-viewmodel";
import { usePaneBoardViewModel } from "./-pane-board-viewmodel";
import type { PaneViewModel } from "./-terminal-viewmodel";
import { usePaneViewModel } from "./-terminal-viewmodel";

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
      retry: 1,
    }),
  );
  const panes = panesQuery.data?.panes ?? [];
  const selectedPane = panes.find((pane) => pane.id === paneId) ?? null;
  const selectedTarget = selectedPane?.tmuxPaneId ?? "";
  const [flickPreview, setFlickPreview] = useState<CustomKeyboardFlickPreview | null>(null);
  const terminal = usePaneViewModel({
    target: selectedTarget,
    connection,
    onFlickPreviewChange: setFlickPreview,
  });
  const keyboardController = useCustomKeyboardViewModel({
    flickPreview,
    onSequence: (sequence, activeModifiers) => {
      terminal.sendInput(encodeCustomKeyboardSequence(sequence, activeModifiers));
    },
    onNativeFileSelected: (_action, file) => {
      terminal.pasteImage(file);
    },
    onNativeKeyboardToggle: (visible) => {
      if (visible) terminal.focus();
      else terminal.blur();
    },
  });
  useEffect(() => {
    terminal.setFlickRepeat({
      startDelayMs: keyboardController.repeatStartDelayMs,
      intervalMs: keyboardController.repeatIntervalMs,
    });
  }, [keyboardController.repeatIntervalMs, keyboardController.repeatStartDelayMs, terminal.setFlickRepeat]);
  const paneBoard = usePaneBoardViewModel({
    selectedTarget,
    sessionName,
    connection,
    utils: resources.utils,
    alwaysOpen: true,
    onSelect: (target) => {
      const pane = panes.find((candidate) => candidate.tmuxPaneId === target);
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
