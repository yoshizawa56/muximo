import {
  type ChangeEvent,
  type DragEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppIcon } from "../../../../../../../../app/components/app-icon";
import { type CustomKeyboardDirectionalFlickPreview, installCustomKeyboardDirectionalFlickInput } from "./flick";
import { isCustomKeyboardModifierKey } from "./input";
import {
  customKeyboardAbcLetterRow,
  customKeyboardAbcRows,
  customKeyboardNumberRows,
  customKeyboardPunctuationRow,
} from "./layout";
import { isCustomKeyboardShortcutDraftValid } from "./policy";
import {
  type CustomKeyboardButton,
  type CustomKeyboardButtonCategory,
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardFlickDirection,
  type CustomKeyboardIcon,
  type CustomKeyboardIconCategory,
  type CustomKeyboardModifier,
  type CustomKeyboardNativeFileAction,
  type CustomKeyboardSequence,
  type CustomKeyboardSequenceToken,
  type CustomKeyboardSettingsViewModel,
  type CustomKeyboardShortcutDraft,
  type CustomKeyboardViewModel,
  customKeyboardIconCategories,
  customKeyboardIconOptions,
  customKeyboardSpecialKeyOptions,
  customKeyboardSpecialModifierOptions,
} from "./viewmodel";

type ShortcutDropIndicator = {
  index: number;
};

type PointerDragState = {
  buttonId: string;
  source: CustomKeyboardDragSource;
  startX: number;
  startY: number;
  started: boolean;
  targetButtonId: string | null;
  targetIndex: number | null;
  overPreview: boolean;
};

type PointerDragPosition = {
  x: number;
  y: number;
};

export function CustomKeyboardView({
  viewModel,
  children,
  nativeKeyboard,
  onOpenSettings,
}: {
  viewModel: CustomKeyboardViewModel;
  children: ReactNode;
  nativeKeyboard?: ReactNode;
  onOpenSettings: () => void;
}) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const pendingNativeFileActionRef = useRef<CustomKeyboardNativeFileAction | null>(null);

  const openNativeFilePicker = useCallback((action: CustomKeyboardNativeFileAction) => {
    pendingNativeFileActionRef.current = action;
    const input = action === "capture-photo" ? cameraInputRef.current : photoInputRef.current;
    if (!input) {
      pendingNativeFileActionRef.current = null;
      return;
    }
    input.value = "";
    input.click();
  }, []);

  const onButtonPress = useCallback(
    (button: CustomKeyboardButton) => {
      const nativeAction = button.nativeAction;
      if (nativeAction) {
        viewModel.onNativeAction(nativeAction);
        if (nativeAction === "pick-photo" || nativeAction === "capture-photo") {
          openNativeFilePicker(nativeAction);
        }
        return;
      }

      const terminalAction = button.terminalAction;
      if (terminalAction) {
        viewModel.onTerminalAction(terminalAction);
        return;
      }

      viewModel.onButtonPress(button);
    },
    [openNativeFilePicker, viewModel],
  );

  const onNativeFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const action = pendingNativeFileActionRef.current;
      pendingNativeFileActionRef.current = null;
      const file = event.currentTarget.files?.[0];
      if (action && file) {
        viewModel.onNativeFileSelected(action, file);
      }
    },
    [viewModel],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
      <CustomKeyboardBar viewModel={viewModel} onButtonPress={onButtonPress} onOpenSettings={onOpenSettings} />
      {viewModel.nativeKeyboardVisible ? nativeKeyboard : null}
      <input
        ref={photoInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onNativeFileChange}
      />
      <input
        ref={cameraInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        capture="environment"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onNativeFileChange}
      />
    </div>
  );
}

export function CustomKeyboardBar({
  viewModel,
  onButtonPress = viewModel.onButtonPress,
  onKeepNativeKeyboardOpen = viewModel.onKeepNativeKeyboardOpen,
  onOpenSettings,
}: {
  viewModel: CustomKeyboardViewModel;
  onButtonPress?: (button: CustomKeyboardButton) => void;
  onKeepNativeKeyboardOpen?: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div
      className="shrink-0 border-t border-[#1c4a28] bg-[rgb(5_15_8_/_98%)] px-[max(5px,var(--safe-area-left))] pb-[max(4px,var(--safe-area-bottom))] pt-1 shadow-[0_-10px_24px_rgb(0_0_0_/_28%)]"
      role="toolbar"
      aria-label="Custom terminal keyboard"
    >
      <div className="mx-auto flex min-w-0 max-w-[1560px] items-stretch gap-1">
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max items-stretch gap-0.5">
            {viewModel.buttons.map((button) => (
              <CustomKeyboardButtonView
                key={button.id}
                button={button}
                active={button.modifier ? viewModel.activeModifiers.includes(button.modifier) : false}
                onPress={onButtonPress}
                onKeepNativeKeyboardOpen={onKeepNativeKeyboardOpen}
                onDirectionalFlick={viewModel.onDirectionalFlick}
                repeatStartDelayMs={viewModel.repeatStartDelayMs}
                repeatIntervalMs={viewModel.repeatIntervalMs}
              />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-stretch gap-0.5 border-l border-[#1c4a28] pl-1">
          <CustomKeyboardActionSurface
            className="grid size-[34px] place-items-center rounded-[6px] border border-[#2a5c36] bg-[#0b2111] px-1 text-[#91d89b] transition-colors hover:border-[#4f9e5e] hover:bg-[#12351a]"
            onPress={onOpenSettings}
            onInteractionStart={onKeepNativeKeyboardOpen}
            preserveNativeKeyboardFocus
            aria-label="Open custom keyboard settings"
            title="Open custom keyboard settings"
          >
            <AppIcon name="sliders" size={16} />
          </CustomKeyboardActionSurface>
          <CustomKeyboardActionSurface
            className={`grid size-[34px] place-items-center rounded-[6px] border px-1 transition-colors ${
              viewModel.nativeKeyboardVisible
                ? "border-[#78b7ff] bg-[#123052] text-[#a9d5ff]"
                : "border-[#2a5c36] bg-[#0b2111] text-[#91d89b] hover:border-[#4f9e5e] hover:bg-[#12351a]"
            }`}
            onPress={viewModel.onToggleNativeKeyboard}
            aria-pressed={viewModel.nativeKeyboardVisible}
            aria-label={viewModel.nativeKeyboardVisible ? "Hide standard keyboard" : "Show standard keyboard"}
            title={viewModel.nativeKeyboardVisible ? "Hide standard keyboard" : "Show standard keyboard"}
          >
            <CustomKeyboardIconView icon="keyboard" size={16} />
          </CustomKeyboardActionSurface>
        </div>
      </div>
    </div>
  );
}

function CustomKeyboardActionSurface({
  className,
  children,
  onPress,
  onInteractionStart,
  preserveNativeKeyboardFocus = false,
  "aria-label": ariaLabel,
  title,
  "aria-pressed": ariaPressed,
}: {
  className: string;
  children: ReactNode;
  onPress: () => void;
  onInteractionStart?: () => void;
  preserveNativeKeyboardFocus?: boolean;
  "aria-label": string;
  title: string;
  "aria-pressed"?: boolean;
}) {
  return (
    <button
      className={className}
      type="button"
      onPointerDown={(event) => {
        event.preventDefault();
        onInteractionStart?.();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        onInteractionStart?.();
      }}
      onFocus={() => {
        if (preserveNativeKeyboardFocus) onInteractionStart?.();
      }}
      onClick={onPress}
      aria-pressed={ariaPressed}
      aria-label={ariaLabel}
      title={title}
      data-preserve-native-keyboard-focus={preserveNativeKeyboardFocus ? "true" : undefined}
    >
      {children}
    </button>
  );
}

function CustomKeyboardButtonView({
  button,
  active,
  onPress,
  onKeepNativeKeyboardOpen,
  onDirectionalFlick,
  repeatStartDelayMs,
  repeatIntervalMs,
}: {
  button: CustomKeyboardButton;
  active: boolean;
  onPress: (button: CustomKeyboardButton) => void;
  onKeepNativeKeyboardOpen: () => void;
  onDirectionalFlick: (direction: CustomKeyboardFlickDirection) => void;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
}) {
  if (button.interaction === "directional-flick") {
    return (
      <CustomKeyboardDirectionalFlickButtonView
        button={button}
        onDirection={onDirectionalFlick}
        onKeepNativeKeyboardOpen={onKeepNativeKeyboardOpen}
        repeatStartDelayMs={repeatStartDelayMs}
        repeatIntervalMs={repeatIntervalMs}
      />
    );
  }
  const displayLabel = keyboardButtonDisplayLabel(button);
  const valueLabel = keyboardButtonValueLabel(button);
  const showValueAsPrimary = valueLabel !== undefined;
  const icon = button.icon;
  const showIcon = icon !== undefined && !showValueAsPrimary;

  return (
    <CustomKeyboardActionSurface
      className={`group relative flex h-[34px] min-w-[34px] shrink-0 flex-col items-center justify-center gap-0 rounded-[6px] border px-1 font-mono transition-[border-color,background-color,transform] active:scale-[0.97] ${
        active
          ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd] shadow-[0_0_0_2px_rgb(139_255_154_/_14%)]"
          : button.kind === "shortcut"
            ? "border-[#315d88] bg-[#0d2237] text-[#a8d7ff] hover:border-[#5a9dd3] hover:bg-[#123452]"
            : "border-[#245631] bg-[#0b1c0f] text-[#b3eebc] hover:border-[#4e9d5d] hover:bg-[#12351a]"
      }`}
      onPress={() => onPress(button)}
      onInteractionStart={button.nativeAction ? undefined : onKeepNativeKeyboardOpen}
      preserveNativeKeyboardFocus={!button.nativeAction}
      aria-pressed={button.modifier ? active : undefined}
      aria-label={button.accessibleLabel}
      title={button.accessibleLabel}
    >
      {showIcon ? (
        <span className="text-[0.7rem] font-bold leading-none tracking-[-0.06em]" aria-hidden="true">
          <CustomKeyboardIconView icon={icon} />
        </span>
      ) : null}
      {showValueAsPrimary ? (
        <span className="max-w-[42px] truncate text-[0.78rem] font-bold leading-none">{valueLabel}</span>
      ) : displayLabel ? (
        <span className="max-w-[38px] truncate text-[0.4rem] font-bold leading-none">{displayLabel}</span>
      ) : null}
      {button.kind === "shortcut" ? (
        <span className="absolute right-0.5 top-0.5 size-0.5 rounded-full bg-[#72c8ff] opacity-80" aria-hidden="true" />
      ) : null}
    </CustomKeyboardActionSurface>
  );
}

function CustomKeyboardDirectionalFlickButtonView({
  button,
  onDirection,
  onKeepNativeKeyboardOpen,
  repeatStartDelayMs,
  repeatIntervalMs,
}: {
  button: CustomKeyboardButton;
  onDirection: (direction: CustomKeyboardFlickDirection) => void;
  onKeepNativeKeyboardOpen: () => void;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<CustomKeyboardDirectionalFlickPreview | null>(null);

  useEffect(() => {
    const element = buttonRef.current;
    if (!element) return;
    return installCustomKeyboardDirectionalFlickInput(element, {
      onDirection,
      repeatStartDelayMs,
      repeatIntervalMs,
      onPreviewChange: setPreview,
    });
  }, [onDirection, repeatIntervalMs, repeatStartDelayMs]);

  return (
    <button
      ref={buttonRef}
      className={`group relative grid h-[34px] min-w-[38px] shrink-0 place-items-center rounded-[6px] border px-1 font-mono transition-[border-color,background-color,transform] active:scale-[0.97] ${
        preview
          ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd] shadow-[0_0_0_2px_rgb(139_255_154_/_14%)]"
          : "border-[#245631] bg-[#0b1c0f] text-[#b3eebc] hover:border-[#4e9d5d] hover:bg-[#12351a]"
      }`}
      style={{ touchAction: "none" }}
      type="button"
      onPointerDown={(event) => {
        onKeepNativeKeyboardOpen();
        event.preventDefault();
      }}
      onMouseDown={(event) => {
        onKeepNativeKeyboardOpen();
        event.preventDefault();
      }}
      onFocus={onKeepNativeKeyboardOpen}
      aria-label={button.accessibleLabel}
      title={button.accessibleLabel}
      data-preserve-native-keyboard-focus="true"
    >
      <DirectionalFlickIcon direction={preview?.direction ?? null} repeating={preview?.repeating ?? false} />
      <span className="sr-only">
        {preview ? `${preview.repeating ? "Repeating" : "Sending"} ${preview.direction} arrow` : "Flick for arrows"}
      </span>
    </button>
  );
}

export function DirectionalFlickIcon({
  direction = null,
  repeating = false,
  showOuterRing = true,
  size = 20,
}: {
  direction?: CustomKeyboardFlickDirection | null;
  repeating?: boolean;
  showOuterRing?: boolean;
  size?: number;
}) {
  const offset = direction
    ? {
        up: { x: 0, y: -3.2 },
        down: { x: 0, y: 3.2 },
        left: { x: -3.2, y: 0 },
        right: { x: 3.2, y: 0 },
      }[direction]
    : { x: 0, y: 0 };
  const centerClass = repeating ? "animate-pulse" : "";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="presentation"
      aria-hidden="true"
    >
      {showOuterRing ? <circle cx="12" cy="12" r="9" strokeWidth="1.35" opacity="0.48" /> : null}
      <path d="M12 3.5v17M3.5 12h17" strokeWidth="1.25" opacity="0.42" />
      <circle className={centerClass} cx={12 + offset.x} cy={12 + offset.y} r="3" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CustomKeyboardSettingsView({
  viewModel,
  onClose,
  onSave,
}: {
  viewModel: CustomKeyboardSettingsViewModel;
  onClose: () => void;
  onSave: () => void;
}) {
  const [draggedButtonId, setDraggedButtonId] = useState<string | null>(null);
  const [pointerDragPosition, setPointerDragPosition] = useState<PointerDragPosition | null>(null);
  const [dropTargetButtonId, setDropTargetButtonId] = useState<string | null>(null);
  const [shortcutDropIndicator, setShortcutDropIndicator] = useState<ShortcutDropIndicator | null>(null);
  const [previewDropActive, setPreviewDropActive] = useState(false);
  const [activeTab, setActiveTab] = useState<CustomKeyboardButtonCategory>("abc");
  const [abcShiftActive, setAbcShiftActive] = useState(false);
  const [numberShiftActive, setNumberShiftActive] = useState(false);
  const [showFlickSettings, setShowFlickSettings] = useState(false);
  const [shortcutModalOpen, setShortcutModalOpen] = useState(false);
  const [shortcutEditMode, setShortcutEditMode] = useState(false);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<CustomKeyboardShortcutDraft>(() => createShortcutDraft());
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dragSourceRef = useRef<CustomKeyboardDragSource | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);

  const addButton = useCallback(
    (button: CustomKeyboardButton) => {
      viewModel.onDrop({ buttonId: button.id, collection: "library" }, { type: "keyboard", targetButtonId: null });
    },
    [viewModel],
  );

  const addButtonFromClick = useCallback(
    (button: CustomKeyboardButton) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      addButton(button);
    },
    [addButton],
  );

  const resetDrag = useCallback(() => {
    setDraggedButtonId(null);
    setPointerDragPosition(null);
    setDropTargetButtonId(null);
    setShortcutDropIndicator(null);
    setPreviewDropActive(false);
    dragSourceRef.current = null;
  }, []);

  const commitDrop = useCallback(
    (
      source: CustomKeyboardDragSource,
      targetButtonId: string | null,
      targetIndex: number | null,
      overPreview: boolean,
    ) => {
      if (shortcutEditMode && overPreview) {
        resetDrag();
        return;
      }
      const target: CustomKeyboardDropTarget =
        shortcutEditMode && activeTab === "shortcuts" && targetIndex !== null
          ? { type: "shortcut-library", targetIndex }
          : { type: "keyboard", targetButtonId: targetButtonId ?? null };
      viewModel.onDrop(source, target);
      resetDrag();
    },
    [activeTab, resetDrag, shortcutEditMode, viewModel],
  );

  const setDragSource = (event: DragEvent<HTMLElement>, source: CustomKeyboardDragSource) => {
    dragSourceRef.current = source;
    setDraggedButtonId(source.buttonId);
    setDropTargetButtonId(null);
    setShortcutDropIndicator(null);
    setPreviewDropActive(false);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", source.buttonId);
    event.dataTransfer.setData("application/x-muximo-keyboard-collection", source.collection);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, targetButtonId?: string, targetIndex?: number) => {
    event.preventDefault();
    const sourceId = draggedButtonId ?? event.dataTransfer.getData("text/plain");
    if (!sourceId) {
      resetDrag();
      return;
    }

    const overPreview = Boolean(event.currentTarget.closest('[data-custom-keyboard-drop-zone="preview"]'));
    const collectionValue = event.dataTransfer.getData("application/x-muximo-keyboard-collection");
    const collection = isCustomKeyboardDragCollection(collectionValue)
      ? collectionValue
      : shortcutEditMode && activeTab === "shortcuts"
        ? "shortcut-library"
        : viewModel.selectedButtonIds.includes(sourceId)
          ? "keyboard"
          : "library";
    const source = dragSourceRef.current ?? { buttonId: sourceId, collection };
    commitDrop(source, targetButtonId ?? null, targetIndex ?? null, overPreview);
  };

  const beginPointerDrag = (event: ReactPointerEvent<HTMLElement>, source: CustomKeyboardDragSource) => {
    if (event.pointerType === "mouse") return;
    pointerDragRef.current = {
      buttonId: source.buttonId,
      source,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      targetButtonId: null,
      targetIndex: null,
      overPreview: false,
    };
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;

      if (!drag.started) {
        const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (distance < 8) return;
        drag.started = true;
        setDraggedButtonId(drag.buttonId);
        dragSourceRef.current = drag.source;
        suppressClickRef.current = true;
      }

      event.preventDefault();
      setPointerDragPosition({ x: event.clientX, y: event.clientY });
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const targetButtonId = target?.closest<HTMLElement>("[data-custom-keyboard-drop-target]")?.dataset
        .customKeyboardDropTarget;
      const targetIndexValue = target?.closest<HTMLElement>("[data-custom-keyboard-drop-index]")?.dataset
        .customKeyboardDropIndex;
      const targetIndex = targetIndexValue === undefined ? null : Number(targetIndexValue);
      const overPreview = Boolean(target?.closest<HTMLElement>('[data-custom-keyboard-drop-zone="preview"]'));
      drag.targetButtonId = targetButtonId ?? null;
      drag.targetIndex =
        shortcutEditMode && activeTab === "shortcuts" && Number.isInteger(targetIndex) ? targetIndex : null;
      drag.overPreview = overPreview;
      setDropTargetButtonId(targetButtonId ?? null);
      setShortcutDropIndicator(drag.targetIndex === null ? null : { index: drag.targetIndex });
      setPreviewDropActive(overPreview);
    };

    const handlePointerUp = () => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      pointerDragRef.current = null;
      if (drag.started) {
        commitDrop(drag.source, drag.targetButtonId, drag.targetIndex, drag.overPreview);
        if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = false;
          suppressClickTimerRef.current = null;
        }, 350);
      } else {
        resetDrag();
      }
    };

    const handlePointerCancel = () => {
      if (!pointerDragRef.current) return;
      pointerDragRef.current = null;
      resetDrag();
      if (suppressClickTimerRef.current !== null) {
        window.clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
      suppressClickRef.current = false;
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
    };
  }, [activeTab, commitDrop, resetDrag, shortcutEditMode]);

  const openShortcutModal = (button?: CustomKeyboardButton) => {
    setEditingShortcutId(button?.id ?? null);
    setShortcutDraft(button ? { icon: button.icon ?? "shortcut", sequence: button.sequence } : createShortcutDraft());
    setShortcutModalOpen(true);
  };

  const closeShortcutModal = () => {
    setShortcutModalOpen(false);
    setEditingShortcutId(null);
  };

  const saveShortcut = () => {
    if (!isCustomKeyboardShortcutDraftValid(shortcutDraft)) return;
    if (editingShortcutId) {
      viewModel.onUpdateShortcut(editingShortcutId, shortcutDraft);
    } else {
      viewModel.onRegisterShortcut(shortcutDraft);
    }
    setShortcutModalOpen(false);
    setEditingShortcutId(null);
    setActiveTab("shortcuts");
  };

  const assignedButtonIds = new Set(viewModel.selectedButtonIds);
  const categoryButtons = Array.from(
    new Map(
      [...viewModel.buttons, ...viewModel.availableButtons]
        .filter((button) => button.category === activeTab)
        .map((button) => [button.id, button] as const),
    ).values(),
  );
  const pointerDraggedButton = draggedButtonId
    ? [...viewModel.buttons, ...viewModel.availableButtons].find((button) => button.id === draggedButtonId)
    : null;
  const draggingShortcutCard =
    activeTab === "shortcuts" && shortcutEditMode && pointerDraggedButton?.kind === "shortcut";

  return (
    <main className="relative flex h-[var(--app-viewport-height)] min-h-0 flex-col overflow-hidden bg-[#061008] text-[#d9f4dc]">
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-[#1d4325] bg-[rgb(6_16_8_/_96%)] px-[max(10px,var(--safe-area-left))] py-2">
        <button
          className="grid size-8 shrink-0 place-items-center rounded-[8px] border border-[#2d5d37] bg-[#0b2111] text-[#a9e8b1]"
          type="button"
          onClick={onClose}
          aria-label="Close custom keyboard settings"
        >
          <AppIcon name="arrow-left" size={15} />
        </button>
        <div className="min-w-0 flex-1">
          <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.16em] text-[#63ae6e]">
            Custom keys
          </span>
          <h1 className="m-0 mt-0.5 truncate text-[0.9rem] font-bold tracking-[-0.03em]">Keyboard settings</h1>
        </div>
        <button
          className="rounded-[8px] bg-[#8bff9a] px-2.5 py-1.5 font-mono text-[0.56rem] font-bold uppercase tracking-[0.08em] text-[#061008]"
          type="button"
          onClick={onSave}
        >
          Save
        </button>
      </header>

      <section
        className={`shrink-0 border-b border-[#1d4927] bg-[rgb(8_24_12_/_92%)] px-3 py-2.5 ${
          shortcutEditMode ? "pointer-events-none opacity-45" : ""
        }`}
        aria-label="Custom keyboard preview"
        aria-disabled={shortcutEditMode}
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
              {shortcutEditMode ? "Locked" : "Preview"}
            </span>
            <h2 className="m-0 mt-0.5 text-[0.82rem] font-bold">Custom keyboard</h2>
          </div>
          <button
            className={`rounded-[7px] border px-2 py-1 font-mono text-[0.5rem] font-bold uppercase tracking-[0.06em] ${
              showFlickSettings
                ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                : "border-[#315f3a] bg-[#0b2411] text-[#8fc998]"
            }`}
            type="button"
            onClick={() => setShowFlickSettings((current) => !current)}
            aria-expanded={showFlickSettings}
          >
            Flick repeat
          </button>
        </div>
        <div
          className={`mt-2 flex min-h-[52px] min-w-0 items-center gap-1 rounded-[9px] border border-dashed bg-[#061008] p-1.5 transition-colors ${
            draggedButtonId === null ? "overflow-x-auto touch-pan-x" : "overflow-x-hidden touch-none"
          } ${previewDropActive ? "border-[#8bff9a] bg-[#102d17]" : "border-[#386e43]"}`}
          data-custom-keyboard-drop-zone="preview"
          role="toolbar"
          aria-label="Custom keyboard preview drop zone"
          onDragEnter={
            shortcutEditMode
              ? undefined
              : (event) => {
                  event.preventDefault();
                  setPreviewDropActive(true);
                }
          }
          onDragOver={
            shortcutEditMode
              ? undefined
              : (event) => {
                  event.preventDefault();
                  setPreviewDropActive(true);
                }
          }
          onDragLeave={shortcutEditMode ? undefined : () => setPreviewDropActive(false)}
          onDrop={shortcutEditMode ? undefined : (event) => handleDrop(event)}
        >
          <div className="flex min-w-max flex-col gap-1">
            <div className="flex min-w-max items-center gap-1">
              {viewModel.buttons.map((button) => (
                <CustomKeyboardPreviewButton
                  key={button.id}
                  button={button}
                  assigned
                  dragging={button.id === draggedButtonId}
                  dropTarget={button.id === dropTargetButtonId}
                  dragEnabled={!shortcutEditMode}
                  onRemove={() => viewModel.onRemoveButton(button.id)}
                  onDragStart={(event) => setDragSource(event, { buttonId: button.id, collection: "keyboard" })}
                  onPointerDown={(event) => beginPointerDrag(event, { buttonId: button.id, collection: "keyboard" })}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDropTargetButtonId(button.id);
                    setPreviewDropActive(true);
                  }}
                  onDrop={(event) => handleDrop(event, button.id)}
                  onDragEnd={resetDrag}
                />
              ))}
              <span
                className={`flex h-[34px] min-w-[92px] shrink-0 items-center justify-center rounded-[6px] border border-dashed px-2 font-mono text-[0.48rem] transition-colors ${
                  previewDropActive ? "border-[#8bff9a] text-[#baffc1]" : "border-[#2a5c36] text-[#628168]"
                }`}
              >
                Drag keys here
              </span>
            </div>
            <div className="h-4" aria-hidden="true" />
          </div>
        </div>
        {showFlickSettings ? (
          <div className="mt-2 rounded-[8px] border border-[#285a33] bg-[#071509] p-2">
            <p className="m-0 text-[0.54rem] text-[#719176]">
              Hold a flick to wait, then repeat the arrow input at the selected interval.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="rounded-[7px] border border-[#1d4325] bg-[#061008] p-2">
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-[0.6rem]">Repeat start delay</strong>
                  <output className="rounded-full border border-[#315f3a] bg-[#0b2411] px-1.5 py-0.5 font-mono text-[0.52rem] font-bold text-[#a9e8b1]">
                    {viewModel.repeatStartDelayMs} ms
                  </output>
                </span>
                <input
                  className="mt-1.5 w-full accent-[#8bff9a]"
                  type="range"
                  min={200}
                  max={1200}
                  step={20}
                  value={viewModel.repeatStartDelayMs}
                  onChange={(event) => viewModel.onRepeatStartDelayChange(Number(event.target.value))}
                  aria-label="Flick repeat start delay"
                />
              </label>
              <label className="rounded-[7px] border border-[#1d4325] bg-[#061008] p-2">
                <span className="flex items-center justify-between gap-2">
                  <strong className="text-[0.6rem]">Arrow repeat interval</strong>
                  <output className="rounded-full border border-[#315f3a] bg-[#0b2411] px-1.5 py-0.5 font-mono text-[0.52rem] font-bold text-[#a9e8b1]">
                    {viewModel.repeatIntervalMs} ms
                  </output>
                </span>
                <input
                  className="mt-1.5 w-full accent-[#8bff9a]"
                  type="range"
                  min={80}
                  max={600}
                  step={20}
                  value={viewModel.repeatIntervalMs}
                  onChange={(event) => viewModel.onRepeatIntervalChange(Number(event.target.value))}
                  aria-label="Flick repeat interval"
                />
              </label>
            </div>
          </div>
        ) : null}
      </section>

      <div
        className="flex shrink-0 overflow-x-auto border-b border-[#1d4325] bg-[#071509] px-2"
        role="tablist"
        aria-label="Custom keyboard assignment categories"
      >
        {customKeyboardSettingsTabs.map((tab) => (
          <button
            className={`min-w-[86px] flex-1 border-b-2 px-2 py-2.5 font-mono text-[0.54rem] font-bold uppercase tracking-[0.08em] ${
              activeTab === tab.value ? "border-[#8bff9a] text-[#d9ffdd]" : "border-transparent text-[#6fa677]"
            }`}
            key={tab.value}
            type="button"
            onClick={() => setActiveTab(tab.value)}
            role="tab"
            aria-selected={activeTab === tab.value}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className={`min-h-0 flex-1 p-3 pb-[max(18px,var(--safe-area-bottom))] ${
          activeTab === "shortcuts" ? "overflow-y-auto" : "overflow-hidden"
        }`}
      >
        {activeTab === "shortcuts" ? (
          <CustomKeyboardShortcutLibrary
            viewModel={viewModel}
            editMode={shortcutEditMode}
            onToggleEditMode={() => setShortcutEditMode((current) => !current)}
            onRegisterShortcut={() => openShortcutModal()}
            onEditShortcut={openShortcutModal}
            draggedButtonId={draggedButtonId}
            onDragStart={(event, source) => setDragSource(event, source)}
            onPointerDown={(event, source) => beginPointerDrag(event, source)}
            onDragOver={(event, targetIndex) => {
              event.preventDefault();
              setShortcutDropIndicator({ index: targetIndex });
            }}
            onDrop={(event, targetIndex) => handleDrop(event, undefined, targetIndex)}
            onDragEnd={resetDrag}
            dropIndicator={shortcutDropIndicator}
          />
        ) : (
          <CustomKeyboardButtonLibrary
            buttons={categoryButtons}
            assignedButtonIds={assignedButtonIds}
            category={activeTab}
            shiftActive={abcShiftActive}
            onToggleShift={() => setAbcShiftActive((current) => !current)}
            numberShiftActive={numberShiftActive}
            onToggleNumberShift={() => setNumberShiftActive((current) => !current)}
            onAddButton={addButtonFromClick}
            onDragStart={(event, source) => setDragSource(event, source)}
            onPointerDown={(event, source) => beginPointerDrag(event, source)}
            onDragEnd={resetDrag}
            draggedButtonId={draggedButtonId}
          />
        )}
      </div>
      {shortcutModalOpen ? (
        <CustomKeyboardShortcutRegistrationModal
          draft={shortcutDraft}
          mode={editingShortcutId ? "edit" : "create"}
          onChange={setShortcutDraft}
          onClose={closeShortcutModal}
          onSubmit={saveShortcut}
        />
      ) : null}
      {pointerDragPosition && pointerDraggedButton ? (
        <div
          className={`pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-[9px] border border-[#8bff9a] bg-[#194d25]/95 font-mono text-[#d9ffdd] shadow-[0_12px_30px_rgb(0_0_0_/_42%)] ${
            draggingShortcutCard
              ? "flex w-[min(260px,calc(100vw-24px))] items-center gap-2 p-2"
              : "flex size-[48px] flex-col items-center justify-center"
          }`}
          style={{ left: pointerDragPosition.x, top: pointerDragPosition.y }}
          aria-hidden="true"
        >
          {pointerDraggedButton.icon ? (
            <span
              className={
                draggingShortcutCard
                  ? "grid size-9 shrink-0 place-items-center rounded-[7px] bg-[#0d2237] text-[0.86rem]"
                  : "text-[0.86rem] font-bold leading-none"
              }
            >
              <CustomKeyboardIconView icon={pointerDraggedButton.icon} />
            </span>
          ) : null}
          {draggingShortcutCard ? (
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-[0.62rem]">{shortcutDisplayLabel(pointerDraggedButton)}</strong>
              <code className="mt-0.5 block truncate text-[0.52rem] text-[#8fc998]">
                {formatSequence(pointerDraggedButton.sequence)}
              </code>
            </span>
          ) : (
            <span className="max-w-[42px] truncate text-[0.42rem] leading-none">
              {pointerDraggedButton.kind === "shortcut"
                ? shortcutDisplayLabel(pointerDraggedButton)
                : (pointerDraggedButton.label ?? "key")}
            </span>
          )}
        </div>
      ) : null}
    </main>
  );
}

const customKeyboardSettingsTabs: readonly { value: CustomKeyboardButtonCategory; label: string }[] = [
  { value: "abc", label: "ABC" },
  { value: "123", label: "123" },
  { value: "special", label: "Special" },
  { value: "shortcuts", label: "Shortcuts" },
];

function isCustomKeyboardDragCollection(value: string): value is CustomKeyboardDragSource["collection"] {
  return value === "keyboard" || value === "library" || value === "shortcut-library";
}

function createShortcutDraft(): CustomKeyboardShortcutDraft {
  return {
    icon: "shortcut",
    sequence: [],
  };
}

function CustomKeyboardPreviewButton({
  button,
  assigned,
  dragging,
  dropTarget,
  dragEnabled,
  onRemove,
  onDragStart,
  onPointerDown,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  button: CustomKeyboardButton;
  assigned: boolean;
  dragging: boolean;
  dropTarget: boolean;
  dragEnabled: boolean;
  onRemove: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const displayLabel = keyboardButtonDisplayLabel(button);
  const valueLabel = keyboardButtonValueLabel(button);
  const showValueAsPrimary = valueLabel !== undefined;
  const icon = button.icon;
  const showIcon = icon !== undefined && !showValueAsPrimary;

  return (
    <fieldset
      className={[
        "relative flex h-[40px] min-w-[40px] shrink-0 items-center rounded-[7px] border px-1 transition-[border-color,background,opacity]",
        assigned ? "border-[#4a8d55] bg-[#12351a]" : "border-[#2a5c36] bg-[#0b2111]",
        dragging ? "opacity-45" : "",
      ].join(" ")}
      aria-label={button.accessibleLabel}
      data-custom-keyboard-drop-target={button.id}
      draggable={dragEnabled}
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {dropTarget ? (
        <span
          className="pointer-events-none absolute -bottom-1 -left-[3px] -top-1 z-10 w-0.5 rounded-full bg-[#8bff9a] shadow-[0_0_8px_rgb(139_255_154_/_75%)]"
          aria-hidden="true"
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center font-mono text-[#c5ffcb]">
        {showIcon ? (
          <span className="max-w-[42px] truncate text-[0.68rem] font-bold leading-none">
            <CustomKeyboardIconView icon={icon} />
          </span>
        ) : null}
        {showValueAsPrimary ? (
          <span className="max-w-[42px] truncate text-[0.72rem] font-bold leading-none">{valueLabel}</span>
        ) : displayLabel ? (
          <span className="max-w-[42px] truncate text-[0.4rem] leading-none">{displayLabel}</span>
        ) : null}
      </div>
      <button
        className="absolute -right-1 -top-1 grid size-3.5 place-items-center rounded-full border border-[#5c302d] bg-[#24100f] text-[0.58rem] leading-none text-[#e8877d]"
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${button.accessibleLabel}`}
      >
        ×
      </button>
    </fieldset>
  );
}

function CustomKeyboardButtonLibrary({
  buttons,
  assignedButtonIds,
  category,
  shiftActive,
  onToggleShift,
  numberShiftActive,
  onToggleNumberShift,
  onAddButton,
  onDragStart,
  onPointerDown,
  onDragEnd,
  draggedButtonId,
}: {
  buttons: readonly CustomKeyboardButton[];
  assignedButtonIds: ReadonlySet<string>;
  category: Exclude<CustomKeyboardButtonCategory, "shortcuts">;
  shiftActive: boolean;
  onToggleShift: () => void;
  numberShiftActive: boolean;
  onToggleNumberShift: () => void;
  onAddButton: (button: CustomKeyboardButton) => void;
  onDragStart: (event: DragEvent<HTMLElement>, source: CustomKeyboardDragSource) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: CustomKeyboardDragSource) => void;
  onDragEnd: () => void;
  draggedButtonId: string | null;
}) {
  const buttonsByLabel = new Map<string, CustomKeyboardButton>();
  for (const button of buttons) {
    const label = keyboardButtonDisplayLabel(button);
    if (label && !buttonsByLabel.has(label.toLowerCase())) buttonsByLabel.set(label.toLowerCase(), button);
  }
  const shiftButton = buttons.find((button) => button.modifier === "shift");

  const renderKey = (label: string) => {
    const button = buttonsByLabel.get(label.toLowerCase());
    if (!button) {
      return (
        <span
          className="grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.72rem] text-[#5a765f]"
          key={label}
          aria-hidden="true"
        >
          {shiftActive && category === "abc" ? label.toUpperCase() : label}
        </span>
      );
    }
    return (
      <CustomKeyboardLibraryKey
        key={button.id}
        button={button}
        assigned={assignedButtonIds.has(button.id)}
        dragged={draggedButtonId === button.id}
        displayLabel={shiftActive && category === "abc" ? label.toUpperCase() : label}
        onAddButton={onAddButton}
        onDragStart={(event, buttonId) =>
          onDragStart(event, {
            buttonId,
            collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
          })
        }
        onPointerDown={(event, buttonId) =>
          onPointerDown(event, {
            buttonId,
            collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
          })
        }
        onDragEnd={onDragEnd}
      />
    );
  };

  const renderRow = (labels: readonly string[], className = "") => (
    <div className={["mx-auto flex w-full max-w-[520px] gap-1.5", className].join(" ")}>
      {labels.map((label) => renderKey(label))}
    </div>
  );

  return (
    <section className="h-full min-h-0 overflow-hidden">
      <div className="flex items-end justify-between gap-2">
        <div>
          <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
            Keyboard library
          </span>
          <h2 className="m-0 mt-0.5 text-[0.86rem] font-bold">
            {category === "abc" ? "Alphabet keyboard" : category === "123" ? "Numbers and symbols" : "Terminal keys"}
          </h2>
        </div>
        <span className="font-mono text-[0.5rem] text-[#6f9d76]">Tap to add · drag to preview</span>
      </div>
      {category === "abc" ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {renderRow(customKeyboardAbcRows[0])}
          {renderRow(customKeyboardAbcRows[1], "px-[4%]")}
          <div className="mx-auto flex w-full max-w-[520px] gap-1.5">
            {shiftButton ? (
              <CustomKeyboardLibraryKey
                button={shiftButton}
                assigned={assignedButtonIds.has(shiftButton.id)}
                dragged={draggedButtonId === shiftButton.id}
                displayLabel="⇧"
                isShiftKey
                shiftActive={shiftActive}
                onAddButton={onAddButton}
                onDragStart={(event, buttonId) =>
                  onDragStart(event, {
                    buttonId,
                    collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
                  })
                }
                onPointerDown={(event, buttonId) =>
                  onPointerDown(event, {
                    buttonId,
                    collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
                  })
                }
                onDragEnd={onDragEnd}
                onToggleShift={onToggleShift}
              />
            ) : (
              <button
                className={`h-[38px] w-[15%] rounded-[6px] border font-sans text-[0.66rem] font-semibold transition-colors ${
                  shiftActive
                    ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                    : "border-[#315f3a] bg-[#0b2411] text-[#8fc998]"
                }`}
                type="button"
                onClick={onToggleShift}
                aria-pressed={shiftActive}
              >
                ⇧
              </button>
            )}
            {customKeyboardAbcLetterRow.map((label) => renderKey(label))}
            <span
              className="grid h-[38px] w-[13%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.68rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              ⌫
            </span>
          </div>
          <div className="mx-auto flex w-full max-w-[520px] gap-1.5">
            <span
              className="grid h-[38px] w-[15%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.56rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              123
            </span>
            <span
              className="grid h-[38px] w-[12%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.8rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              ◉
            </span>
            <span
              className="grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.56rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              space
            </span>
            <span
              className="grid h-[38px] w-[18%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.56rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              return
            </span>
          </div>
        </div>
      ) : null}
      {category === "123" ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {(numberShiftActive ? customKeyboardNumberRows.shifted : customKeyboardNumberRows.base).map((row) =>
            renderRow(row),
          )}
          <div className="mx-auto flex w-full max-w-[520px] gap-1.5">
            {customKeyboardPunctuationRow.map((label) => renderKey(label))}
            <span
              className="grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.68rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              ⌫
            </span>
          </div>
          <div className="mx-auto flex w-full max-w-[520px] gap-1.5">
            <button
              className={`grid h-[38px] w-[15%] place-items-center rounded-[6px] border font-sans text-[0.56rem] transition-colors ${
                numberShiftActive
                  ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                  : "border-[#263d2a] bg-[#0a160c] text-[#6c8b72]"
              }`}
              type="button"
              onClick={onToggleNumberShift}
              aria-pressed={numberShiftActive}
              aria-label={numberShiftActive ? "Show numbers and basic symbols" : "Show more symbols"}
            >
              {numberShiftActive ? "123" : "#+="}
            </button>
            <span
              className="grid h-[38px] w-[12%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.8rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              ◉
            </span>
            <span
              className="grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.56rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              space
            </span>
            <span
              className="grid h-[38px] w-[18%] place-items-center rounded-[6px] border border-[#263d2a] bg-[#0a160c] font-sans text-[0.56rem] text-[#6c8b72]"
              aria-hidden="true"
            >
              return
            </span>
          </div>
        </div>
      ) : null}
      {category === "special" ? (
        <div className="mt-3 grid grid-cols-4 gap-1.5">
          {buttons.map((button) => (
            <CustomKeyboardLibraryKey
              key={button.id}
              button={button}
              assigned={assignedButtonIds.has(button.id)}
              dragged={draggedButtonId === button.id}
              displayLabel={specialLibraryDisplayLabel(button)}
              displayIcon
              onAddButton={onAddButton}
              onDragStart={(event, buttonId) =>
                onDragStart(event, {
                  buttonId,
                  collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
                })
              }
              onPointerDown={(event, buttonId) =>
                onPointerDown(event, {
                  buttonId,
                  collection: assignedButtonIds.has(buttonId) ? "keyboard" : "library",
                })
              }
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function keyboardButtonDisplayLabel(button: CustomKeyboardButton): string | undefined {
  if (button.kind === "shortcut") return shortcutDisplayLabel(button);
  if (button.category === "special") return specialLibraryDisplayLabel(button);
  return keyboardButtonValueLabel(button);
}

function keyboardButtonValueLabel(button: CustomKeyboardButton): string | undefined {
  if (button.kind === "shortcut" || button.kind === "modifier") return undefined;
  if (button.category === "abc" || button.category === "123" || !button.icon) {
    if (button.label) return button.label;
    const [token] = button.sequence;
    if (token?.type === "text") return token.value;
    if (token?.type === "key" && token.key.length <= 2 && !token.modifiers?.length) return token.key;
  }
  return undefined;
}

function CustomKeyboardLibraryKey({
  button,
  assigned,
  dragged,
  displayLabel,
  isShiftKey = false,
  shiftActive = false,
  displayIcon = false,
  onAddButton,
  onDragStart,
  onPointerDown,
  onDragEnd,
  onToggleShift,
}: {
  button: CustomKeyboardButton;
  assigned: boolean;
  dragged: boolean;
  displayLabel: string;
  isShiftKey?: boolean;
  shiftActive?: boolean;
  displayIcon?: boolean;
  onAddButton: (button: CustomKeyboardButton) => void;
  onDragStart: (event: DragEvent<HTMLElement>, buttonId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, buttonId: string) => void;
  onDragEnd: () => void;
  onToggleShift?: () => void;
}) {
  return (
    <button
      className={[
        "relative grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border font-sans text-[0.68rem] font-semibold transition-colors touch-none",
        assigned
          ? isShiftKey && shiftActive
            ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
            : "border-[#4a8d55] bg-[#12351a] text-[#b7f4bf]"
          : "border-dashed border-[#2e6540] bg-[#0a1c0e] text-[#a9e8b1] hover:border-[#70c27b] hover:bg-[#102d17]",
        isShiftKey && shiftActive && !assigned ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]" : "",
        isShiftKey ? "w-[15%] flex-none" : "",
        dragged ? "opacity-45" : "",
      ].join(" ")}
      type="button"
      draggable
      onDragStart={(event) => onDragStart(event, button.id)}
      onPointerDown={(event) => onPointerDown(event, button.id)}
      onDragEnd={onDragEnd}
      onClick={() => {
        if (isShiftKey) {
          onToggleShift?.();
        } else if (!assigned) {
          onAddButton(button);
        }
      }}
      aria-label={
        isShiftKey
          ? "Toggle Shift keyboard key"
          : assigned
            ? `${button.accessibleLabel}, already on custom keyboard`
            : `Add ${button.accessibleLabel}`
      }
      aria-pressed={isShiftKey ? shiftActive : assigned}
    >
      <span aria-hidden="true">
        {displayIcon ? (
          button.icon ? (
            <span className="flex flex-col items-center justify-center gap-0.5 leading-none">
              <CustomKeyboardIconView icon={button.icon} />
              <span className="max-w-[52px] truncate text-[0.5rem]">{displayLabel}</span>
            </span>
          ) : (
            displayLabel
          )
        ) : (
          displayLabel
        )}
      </span>
    </button>
  );
}

function CustomKeyboardShortcutLibrary({
  viewModel,
  editMode,
  onToggleEditMode,
  onRegisterShortcut,
  onEditShortcut,
  draggedButtonId,
  onDragStart,
  onPointerDown,
  onDragOver,
  onDrop,
  onDragEnd,
  dropIndicator,
}: {
  viewModel: CustomKeyboardSettingsViewModel;
  editMode: boolean;
  onToggleEditMode: () => void;
  onRegisterShortcut: () => void;
  onEditShortcut: (button: CustomKeyboardButton) => void;
  draggedButtonId: string | null;
  onDragStart: (event: DragEvent<HTMLElement>, source: CustomKeyboardDragSource) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: CustomKeyboardDragSource) => void;
  onDragOver: (event: DragEvent<HTMLElement>, targetIndex: number) => void;
  onDrop: (event: DragEvent<HTMLElement>, targetIndex: number) => void;
  onDragEnd: () => void;
  dropIndicator: ShortcutDropIndicator | null;
}) {
  const shortcuts = viewModel.shortcutButtons;

  const renderDropZone = (index: number) => {
    const active = editMode && dropIndicator?.index === index && draggedButtonId !== null;
    return (
      <button
        className="relative h-2 w-full appearance-none border-0 bg-transparent p-0"
        key={`shortcut-drop-${index}`}
        type="button"
        aria-label={`Insert shortcut at position ${index + 1}`}
        data-custom-keyboard-drop-index={editMode ? index : undefined}
        onDragOver={editMode ? (event) => onDragOver(event, index) : undefined}
        onDrop={editMode ? (event) => onDrop(event, index) : undefined}
      >
        {active ? (
          <div
            className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 items-center gap-1"
            aria-hidden="true"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-[#8bff9a] shadow-[0_0_8px_rgb(139_255_154_/_80%)]" />
            <span className="h-[2px] min-w-0 flex-1 rounded-full bg-[#8bff9a] shadow-[0_0_8px_rgb(139_255_154_/_55%)]" />
          </div>
        ) : null}
      </button>
    );
  };

  return (
    <section className="h-full min-h-0 overflow-hidden">
      <div className="flex items-end justify-between gap-2">
        <div>
          <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
            Shortcut library
          </span>
          <h2 className="m-0 mt-0.5 text-[0.86rem] font-bold">Registered shortcuts</h2>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            className={`rounded-[7px] border px-2 py-1.5 font-mono text-[0.52rem] font-bold uppercase tracking-[0.06em] ${
              editMode ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]" : "border-[#315f3a] bg-[#0b2411] text-[#9bd7a3]"
            }`}
            type="button"
            onClick={onToggleEditMode}
            aria-label={editMode ? "Finish editing shortcuts" : "Edit shortcuts"}
            aria-pressed={editMode}
          >
            {editMode ? "Done" : "Edit"}
          </button>
          <button
            className="rounded-[7px] bg-[#8bff9a] px-2 py-1.5 font-mono text-[0.52rem] font-bold uppercase tracking-[0.06em] text-[#061008]"
            type="button"
            onClick={onRegisterShortcut}
            aria-label="Register shortcut"
          >
            + Register
          </button>
        </div>
      </div>
      <p className="m-0 mt-2 text-[0.58rem] text-[#719176]">
        {editMode
          ? "Edit or delete any shortcut. Drag cards between the position lines."
          : "Drag shortcuts to the custom bar. Use Edit to update or delete them."}
      </p>
      <div className="mt-3 grid gap-0">
        {shortcuts.map((button, index) => {
          const assigned = viewModel.selectedButtonIds.includes(button.id);
          const canReorder = editMode;
          return (
            <Fragment key={button.id}>
              {renderDropZone(index)}
              <fieldset
                className={[
                  "flex min-w-0 items-center gap-1.5 rounded-[8px] border p-1.5 transition-[border-color,box-shadow,opacity,transform]",
                  canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-default",
                  assigned ? "border-[#4a8d55] bg-[#12351a]" : "border-dashed border-[#2e6540] bg-[#0a1c0e]",
                  draggedButtonId === button.id ? "scale-[1.01] opacity-45 shadow-[0_8px_20px_rgb(0_0_0_/_28%)]" : "",
                ].join(" ")}
                aria-label={button.accessibleLabel}
                draggable
                onDragStart={(event) =>
                  onDragStart(event, {
                    buttonId: button.id,
                    collection: editMode ? "shortcut-library" : assigned ? "keyboard" : "library",
                  })
                }
                onPointerDown={(event) =>
                  onPointerDown(event, {
                    buttonId: button.id,
                    collection: editMode ? "shortcut-library" : assigned ? "keyboard" : "library",
                  })
                }
                onDragEnd={onDragEnd}
              >
                {canReorder ? (
                  <span
                    className="mr-0.5 shrink-0 cursor-grab select-none px-0.5 text-[0.52rem] leading-none text-[#5d8b65]"
                    aria-hidden="true"
                  >
                    ⋮⋮
                  </span>
                ) : null}
                <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                  <span className="grid size-8 shrink-0 place-items-center rounded-[7px] border border-[#315d88] bg-[#0d2237] font-mono text-[0.72rem] font-bold text-[#a8d7ff]">
                    {button.icon ? <CustomKeyboardIconView icon={button.icon} /> : null}
                    <span className="sr-only">{button.accessibleLabel}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[0.62rem] text-[#c9f6ce]">
                      {shortcutDisplayLabel(button)}
                    </strong>
                    <code className="mt-0.5 block truncate font-mono text-[0.54rem] text-[#6e9c75]">
                      {formatSequence(button.sequence)}
                    </code>
                  </span>
                </div>
                {editMode ? (
                  <div className="relative z-20 ml-auto flex shrink-0 items-center gap-0.5">
                    <button
                      className="grid size-7 place-items-center rounded-[6px] border border-[#315f3a] bg-[#0b2411] font-mono text-[0.72rem] text-[#9bd7a3]"
                      type="button"
                      onClick={() => onEditShortcut(button)}
                      aria-label={`Edit ${button.accessibleLabel}`}
                    >
                      ✎
                    </button>
                    <button
                      className="grid size-7 place-items-center rounded-[6px] border border-[#5c302d] bg-[#24100f] font-mono text-[0.72rem] text-[#e8877d]"
                      type="button"
                      onClick={() => viewModel.onDeleteShortcut(button.id)}
                      aria-label={`Delete ${button.accessibleLabel}`}
                    >
                      ×
                    </button>
                  </div>
                ) : null}
              </fieldset>
            </Fragment>
          );
        })}
        {renderDropZone(shortcuts.length)}
      </div>
      {shortcuts.length === 0 ? (
        <p className="mt-3 rounded-[9px] border border-dashed border-[#2b5933] p-3 text-[0.64rem] text-[#719176]">
          No shortcuts registered yet. Use Register to create one in the modal.
        </p>
      ) : null}
    </section>
  );
}

function CustomKeyboardIconPicker({
  value,
  onChange,
}: {
  value: CustomKeyboardIcon;
  onChange: (icon: CustomKeyboardIcon) => void;
}) {
  const selectedCategory = customKeyboardIconOptions.find((option) => option.value === value)?.category ?? "terminal";
  const [activeCategory, setActiveCategory] = useState<CustomKeyboardIconCategory>(selectedCategory);
  const visibleOptions = customKeyboardIconOptions.filter((option) => option.category === activeCategory);

  return (
    <div className="mt-1.5">
      <div
        className="flex gap-1 overflow-x-auto rounded-[7px] border border-[#1d4325] bg-[#061008] p-0.5"
        role="tablist"
        aria-label="Icon categories"
      >
        {customKeyboardIconCategories.map((category) => (
          <button
            className={`min-w-0 flex-1 rounded-[5px] px-1.5 py-1.5 font-mono text-[0.48rem] font-bold uppercase tracking-[0.06em] ${
              activeCategory === category.value ? "bg-[#194d25] text-[#d9ffdd]" : "text-[#6fa677] hover:text-[#b9f4bf]"
            }`}
            key={category.value}
            type="button"
            onClick={() => setActiveCategory(category.value)}
            role="tab"
            aria-selected={activeCategory === category.value}
          >
            {category.label}
          </button>
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-8 gap-1">
        {visibleOptions.map((option) => (
          <button
            className={`grid size-8 place-items-center rounded-[6px] border font-mono text-[0.62rem] font-bold transition-colors ${
              value === option.value
                ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                : "border-[#244d2d] bg-[#0a1c0e] text-[#80b888] hover:border-[#70c27b] hover:bg-[#102d17]"
            }`}
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-label={`Use ${option.label} icon`}
            aria-pressed={value === option.value}
            title={option.label}
          >
            <CustomKeyboardIconView icon={option.value} />
          </button>
        ))}
      </div>
    </div>
  );
}

function CustomKeyboardShortcutRegistrationModal({
  draft,
  mode,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: CustomKeyboardShortcutDraft;
  mode: "create" | "edit";
  onChange: (draft: CustomKeyboardShortcutDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-end bg-[rgb(0_0_0_/_58%)] p-2 backdrop-blur-[2px] sm:place-items-center">
      <section
        className="flex max-h-[calc(100dvh-16px)] w-full max-w-[520px] flex-col overflow-hidden rounded-[14px] border border-[#2c6036] bg-[#071509] text-[#d9f4dc] shadow-[0_24px_80px_rgb(0_0_0_/_46%)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-registration-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[#1d4325] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
              Shortcut library
            </span>
            <h2 id="shortcut-registration-title" className="m-0 mt-0.5 text-[0.9rem] font-bold">
              {mode === "edit" ? "Edit shortcut" : "Register shortcut"}
            </h2>
          </div>
          <button
            className="grid size-8 place-items-center rounded-[7px] border border-[#315f3a] bg-[#0b2411] text-[#a9e8b1]"
            type="button"
            onClick={onClose}
            aria-label="Close shortcut registration"
          >
            ×
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-3">
          <fieldset>
            <legend className="font-mono text-[0.52rem] font-bold uppercase tracking-[0.12em] text-[#6fa677]">
              Icon
            </legend>
            <CustomKeyboardIconPicker value={draft.icon} onChange={(icon) => onChange({ ...draft, icon })} />
          </fieldset>
          <div className="mt-3">
            <CustomKeyboardSequenceEditor
              sequence={draft.sequence}
              onChange={(sequence) => onChange({ ...draft, sequence })}
            />
          </div>
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-[#1d4325] px-3 py-2.5">
          <button
            className="rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-3 py-2 font-mono text-[0.56rem] font-bold uppercase tracking-[0.06em] text-[#9bd7a3]"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-[7px] bg-[#8bff9a] px-3 py-2 font-mono text-[0.56rem] font-bold uppercase tracking-[0.06em] text-[#061008] disabled:cursor-not-allowed disabled:opacity-35"
            type="button"
            onClick={onSubmit}
            disabled={draft.sequence.length === 0}
          >
            {mode === "edit" ? "Save shortcut" : "Create shortcut"}
          </button>
        </footer>
      </section>
    </div>
  );
}

const sequencePaletteModifiers: readonly CustomKeyboardModifier[] = customKeyboardSpecialModifierOptions.map(
  ({ modifier }) => modifier,
);
const sequenceSpecialKeys = customKeyboardSpecialKeyOptions;
const sequenceKeyLabels: Readonly<Record<string, string>> = Object.fromEntries(
  sequenceSpecialKeys.map(({ key, accessibleLabel }) => [key, accessibleLabel]),
);

function CustomKeyboardSequenceEditor({
  sequence,
  onChange,
}: {
  sequence: CustomKeyboardSequence;
  onChange: (sequence: CustomKeyboardSequence) => void;
}) {
  const [textDraft, setTextDraft] = useState("");
  const [pendingModifiers, setPendingModifiers] = useState<CustomKeyboardModifier[]>([]);
  const textInputRef = useRef<HTMLInputElement>(null);

  const appendText = () => {
    if (!textDraft) return;
    onChange([...sequence, { type: "text", value: textDraft }]);
    setTextDraft("");
  };

  const appendKey = (key: string, modifiers = pendingModifiers) => {
    const nextSequence = [...sequence];
    if (textDraft) nextSequence.push({ type: "text", value: textDraft });
    nextSequence.push(
      modifiers.length > 0
        ? { type: "key", key: normalizeSequenceKey(key), modifiers: [...modifiers] }
        : { type: "key", key: normalizeSequenceKey(key) },
    );
    onChange(nextSequence);
    setTextDraft("");
    setPendingModifiers([]);
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isCustomKeyboardModifierKey(event.key)) return;
    const eventModifiers = keyboardEventModifiers(event);
    const shouldCaptureSpecialKey = ["Enter", "Tab", "Escape"].includes(event.key);
    const shouldCaptureCombination = event.ctrlKey || event.altKey || pendingModifiers.length > 0;
    if (!shouldCaptureSpecialKey && !shouldCaptureCombination) return;
    if (shouldCaptureCombination && event.key.length === 0) return;

    event.preventDefault();
    appendKey(event.key, eventModifiers.length > 0 ? eventModifiers : pendingModifiers);
  };

  const toggleModifier = (modifier: CustomKeyboardModifier) => {
    setPendingModifiers((current) =>
      current.includes(modifier) ? current.filter((candidate) => candidate !== modifier) : [...current, modifier],
    );
  };

  const removeToken = (index: number) => {
    onChange(sequence.filter((_, tokenIndex) => tokenIndex !== index));
  };

  const undoLastToken = () => {
    onChange(sequence.slice(0, -1));
  };

  const clearEditor = () => {
    onChange([]);
    setTextDraft("");
    setPendingModifiers([]);
  };

  return (
    <fieldset className="flex flex-col gap-3 border-0 p-0">
      <legend className="font-mono text-[0.52rem] font-bold uppercase tracking-[0.12em] text-[#6fa677]">
        Send sequence
      </legend>
      <div className="rounded-[9px] border border-[#285a33] bg-[#071509] p-2">
        {sequence.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Sequence tokens">
            {sequenceWithStableKeys(sequence).map(({ token, index, key }) => (
              <li key={key}>
                <button
                  className={`max-w-full rounded-[7px] border px-2 py-1 font-mono text-[0.62rem] font-bold transition-colors hover:border-[#8bff9a] hover:bg-[#194d25] ${
                    token.type === "text"
                      ? "border-[#315f3a] bg-[#0e2b16] text-[#b9f4bf]"
                      : "border-[#315d88] bg-[#0d2237] text-[#a8d7ff]"
                  }`}
                  type="button"
                  onClick={() => removeToken(index)}
                  aria-label={`Remove ${formatSequenceToken(token)} token`}
                  title="Remove token"
                >
                  <span className="truncate">{formatSequenceToken(token)}</span>
                  <span className="ml-1 text-[0.7rem] opacity-70" aria-hidden="true">
                    ×
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-[0.68rem] text-[#628168]">No tokens yet. Add text or a key operation below.</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            ref={textInputRef}
            className="min-h-10 min-w-0 flex-1 rounded-[8px] border border-[#285a33] bg-[#071509] px-2.5 font-mono text-[0.7rem] text-[#d9f4dc] outline-none placeholder:text-[#52765b] focus:border-[#8bff9a]"
            value={textDraft}
            onChange={(event) => setTextDraft(event.target.value)}
            onKeyDown={onTextKeyDown}
            placeholder="Type text with the standard keyboard"
            aria-label="Text to append"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            className="shrink-0 rounded-[8px] border border-[#3d7048] bg-[#0e2b16] px-2.5 font-mono text-[0.58rem] font-bold text-[#b9f4bf] disabled:opacity-35"
            type="button"
            onClick={appendText}
            disabled={!textDraft}
          >
            Add text
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            className="rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-2 py-1 font-mono text-[0.54rem] font-bold text-[#8fc998]"
            type="button"
            onClick={() => textInputRef.current?.focus()}
          >
            Focus input
          </button>
          <button
            className="rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-2 py-1 font-mono text-[0.54rem] font-bold text-[#8fc998] disabled:opacity-35"
            type="button"
            onClick={undoLastToken}
            disabled={sequence.length === 0}
          >
            Undo
          </button>
          <button
            className="rounded-[7px] border border-[#5c302d] bg-[#24100f] px-2 py-1 font-mono text-[0.54rem] font-bold text-[#e8877d] disabled:opacity-35"
            type="button"
            onClick={clearEditor}
            disabled={sequence.length === 0 && !textDraft && pendingModifiers.length === 0}
          >
            Clear
          </button>
          <span className="ml-auto text-right font-mono text-[0.5rem] text-[#628168]">Tap a token to remove it</span>
        </div>
      </div>

      <div className="rounded-[9px] border border-[#1f4829] bg-[#081b0c] p-2.5">
        <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">Sequence modifiers</legend>
          {sequencePaletteModifiers.map((modifier) => {
            const active = pendingModifiers.includes(modifier);
            return (
              <button
                className={`rounded-[7px] border px-2.5 py-1.5 font-mono text-[0.58rem] font-bold transition-colors ${
                  active
                    ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                    : "border-[#315f3a] bg-[#0b2411] text-[#9bd7a3] hover:border-[#70c27b]"
                }`}
                key={modifier}
                type="button"
                onClick={() => toggleModifier(modifier)}
                aria-pressed={active}
                aria-label={`${modifierLabel(modifier)} modifier`}
              >
                {modifierLabel(modifier)}
              </button>
            );
          })}
          {pendingModifiers.length > 0 ? (
            <span className="self-center font-mono text-[0.52rem] text-[#8fc998]">
              {pendingModifiers.map(modifierLabel).join(" + ")} ready
            </span>
          ) : null}
        </fieldset>

        <fieldset className="mt-2 rounded-[7px] border border-[#1d4325] bg-[#061008] p-2">
          <legend className="px-1 font-mono text-[0.5rem] font-bold uppercase tracking-[0.1em] text-[#6fa677]">
            Special keys
          </legend>
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {sequenceSpecialKeys.map(({ key, label, accessibleLabel, icon }) => (
              <button
                className="grid min-h-9 place-items-center rounded-[6px] border border-[#2a5c36] bg-[#0b2111] px-1.5 font-mono text-[0.7rem] font-bold text-[#b9f4bf] hover:border-[#8bff9a] hover:bg-[#194d25]"
                key={key}
                type="button"
                onClick={() => appendKey(key)}
                aria-label={`Add ${accessibleLabel} key`}
                title={accessibleLabel}
              >
                <span className="flex flex-col items-center justify-center gap-0.5 leading-none">
                  {icon ? <CustomKeyboardIconView icon={icon} /> : null}
                  {label ? <span className="max-w-full truncate text-[0.5rem]">{label}</span> : null}
                </span>
              </button>
            ))}
          </div>
        </fieldset>
        <p className="m-0 mt-2 text-[0.58rem] leading-[1.45] text-[#628168]">
          Type printable text above. Use a modifier followed by a key for combinations such as Ctrl+C.
        </p>
      </div>
    </fieldset>
  );
}

function CustomKeyboardIconView({ icon, size = 15 }: { icon: CustomKeyboardIcon; size?: number }) {
  const iconProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    role: "presentation" as const,
    "aria-hidden": true,
  };

  switch (icon) {
    case "directional-flick":
      return <DirectionalFlickIcon size={size} />;
    case "camera":
      return (
        <svg {...iconProps}>
          <title>Camera</title>
          <path d="M4 8.5h4l1.5-2h5L16 8.5h4v10H4z" />
          <circle cx="12" cy="13.5" r="3.2" />
        </svg>
      );
    case "photo":
      return (
        <svg {...iconProps}>
          <title>Photo library</title>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.2" />
          <path d="m5.5 17 4.5-4 3 2.5 2.1-2 3.4 3.5" />
        </svg>
      );
    case "microphone":
      return (
        <svg {...iconProps}>
          <title>Microphone</title>
          <rect x="9" y="3.5" width="6" height="11" rx="3" />
          <path d="M6 11a6 6 0 0 0 12 0M12 17v3M9 20h6" />
        </svg>
      );
    case "screenshot":
      return (
        <svg {...iconProps}>
          <title>Screenshot</title>
          <path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3M16 20h3a1 1 0 0 0 1-1v-3" />
          <rect x="8" y="8" width="8" height="8" rx="1" />
        </svg>
      );
    case "share":
      return (
        <svg {...iconProps}>
          <title>Share</title>
          <path d="M5 10v9h14v-9M12 15V4m0 0 4 4m-4-4L8 8" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...iconProps}>
          <title>Clipboard</title>
          <rect x="5" y="5" width="14" height="16" rx="2" />
          <path d="M9 5.5V4h6v1.5M8.5 10h7M8.5 14h7M8.5 18h4" />
        </svg>
      );
    case "keyboard":
      return (
        <svg {...iconProps}>
          <title>Keyboard</title>
          <rect x="3" y="6.5" width="18" height="11" rx="2" />
          <path d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M18 10h.01M6.5 13h.01M9.5 13h.01M12.5 13h5" />
        </svg>
      );
    case "globe":
      return (
        <svg {...iconProps}>
          <title>Globe</title>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.1-3.3-8.5S9.8 5.8 12 3.5Z" />
        </svg>
      );
    case "flashlight":
      return (
        <svg {...iconProps}>
          <title>Flashlight</title>
          <path d="m9 3 6 2-1.2 3.5-2.6 1.5 2.2 7.5-3.8 1.3-2.2-7.5-2.8-1zM7.8 8.5l6 2" />
        </svg>
      );
    case "phone":
      return (
        <svg {...iconProps}>
          <title>Phone</title>
          <path d="M7 3.8 10 3l2 4-2 1.5a13.5 13.5 0 0 0 5.5 5.5L17 12l4 2-0.8 3c-.4 1.6-2 2.6-3.6 2.3A16.5 16.5 0 0 1 4.7 5.4C4.4 3.8 5.4 2.2 7 1.8" />
        </svg>
      );
    case "qr":
      return (
        <svg {...iconProps}>
          <title>QR scanner</title>
          <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-6v-2h4z" />
        </svg>
      );
    case "volume-up":
    case "volume-down":
      return (
        <svg {...iconProps}>
          <title>{icon === "volume-up" ? "Volume up" : "Volume down"}</title>
          <path d="M4 10h3l4-3v10l-4-3H4z" />
          {icon === "volume-up" ? (
            <path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" />
          ) : (
            <path d="M15 10.5a2 2 0 0 1 0 3" />
          )}
        </svg>
      );
    case "lock":
      return (
        <svg {...iconProps}>
          <title>Lock</title>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2" />
        </svg>
      );
    default:
      return <span>{keyboardIconGlyph(icon)}</span>;
  }
}

function keyboardIconGlyph(icon: CustomKeyboardIcon): string {
  return customKeyboardIconOptions.find((option) => option.value === icon)?.glyph ?? "?";
}

function shortcutDisplayLabel(button: CustomKeyboardButton): string {
  const sequenceLabel = button.sequence
    .map((token) => (token.type === "text" ? token.value : formatSequenceKeyLabel(token.key, token.modifiers ?? [])))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  const compactLabel = Array.from(sequenceLabel).slice(0, 4).join("").trim();
  return compactLabel || "···";
}

function sequenceWithStableKeys(sequence: CustomKeyboardSequence): readonly {
  token: CustomKeyboardSequenceToken;
  index: number;
  key: string;
}[] {
  const occurrences = new Map<string, number>();
  return sequence.map((token, index) => {
    const serializedToken = JSON.stringify(token);
    const occurrence = occurrences.get(serializedToken) ?? 0;
    occurrences.set(serializedToken, occurrence + 1);
    return { token, index, key: `${serializedToken}-${occurrence}` };
  });
}

function specialLibraryDisplayLabel(button: CustomKeyboardButton): string {
  if (button.icon === "escape") return "";
  const iconOption = customKeyboardIconOptions.find((option) => option.value === button.icon);
  return button.label ?? iconOption?.label ?? button.accessibleLabel;
}

function formatSequence(sequence: CustomKeyboardSequence): string {
  if (sequence.length === 0) return "modifier";
  return sequence.map(formatSequenceToken).join(" → ");
}

function formatSequenceToken(token: CustomKeyboardSequenceToken): string {
  if (token.type === "text") return `Text: ${JSON.stringify(token.value)}`;
  return formatSequenceKeyLabel(token.key, token.modifiers ?? []);
}

function formatSequenceKeyLabel(key: string, modifiers: readonly CustomKeyboardModifier[]): string {
  const keyLabel = sequenceKeyLabels[key] ?? (key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key);
  const modifierLabelValue = modifiers.map(modifierLabel).join("+");
  return modifierLabelValue ? `${modifierLabelValue}+${keyLabel}` : keyLabel;
}

function modifierLabel(modifier: CustomKeyboardModifier): string {
  return modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift";
}

function keyboardEventModifiers(event: KeyboardEvent<HTMLInputElement>): CustomKeyboardModifier[] {
  return [event.ctrlKey ? "ctrl" : null, event.altKey ? "alt" : null, event.shiftKey ? "shift" : null].filter(
    (modifier): modifier is CustomKeyboardModifier => modifier !== null,
  );
}

function normalizeSequenceKey(key: string): string {
  return key.length === 1 && /[a-z]/i.test(key) ? key.toLowerCase() : key;
}
