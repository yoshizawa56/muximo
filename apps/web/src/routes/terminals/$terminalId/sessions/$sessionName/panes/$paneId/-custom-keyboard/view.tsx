import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  type ChangeEvent,
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { AppIcon } from "../../../../../../../../app/components/app-icon";
import { AppSafeAreaOverlay } from "../../../../../../../../app/components/app-layout";
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
  CUSTOM_KEYBOARD_EDITABLE_ROW_ID,
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardFlickDirection,
  type CustomKeyboardIcon,
  type CustomKeyboardIconCategory,
  type CustomKeyboardKey,
  type CustomKeyboardKeyCategory,
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
  DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
  isCustomKeyboardProfileNameValid,
} from "./viewmodel";

type ShortcutDropIndicator = {
  index: number;
};

type CustomKeyboardDndDropTarget =
  | { kind: "preview" }
  | { kind: "preview-row"; rowId: string }
  | { kind: "preview-key"; rowId: string; targetKeyId: string }
  | { kind: "shortcut-library"; targetIndex: number };

const CUSTOM_KEYBOARD_TOUCH_DRAG_DELAY_MS = 200;
const CUSTOM_KEYBOARD_TOUCH_DRAG_TOLERANCE_PX = 8;
const CUSTOM_KEYBOARD_MOUSE_DRAG_DISTANCE_PX = 8;

type CustomKeyboardDndSession = {
  source: CustomKeyboardDragSource;
  moved: boolean;
  targetRowId: string | null;
  targetKeyId: string | null;
  targetIndex: number | null;
  overPreview: boolean;
};

const customKeyboardCollisionDetection: CollisionDetection = (args) => {
  const collisions = pointerWithin(args);

  return collisions.sort((left, right) => {
    const leftPriority = customKeyboardDropTargetPriority(
      left.data?.droppableContainer.data.current?.customKeyboardDropTarget,
    );
    const rightPriority = customKeyboardDropTargetPriority(
      right.data?.droppableContainer.data.current?.customKeyboardDropTarget,
    );
    return rightPriority - leftPriority;
  });
};

function customKeyboardDropTargetPriority(value: unknown): number {
  if (!value || typeof value !== "object") return 0;

  switch ((value as { kind?: unknown }).kind) {
    case "preview-key":
      return 4;
    case "shortcut-library":
      return 3;
    case "preview-row":
      return 2;
    case "preview":
      return 1;
    default:
      return 0;
  }
}

export type CustomKeyboardClipboardHistoryEntry = {
  id: string;
  source: "Device clipboard" | "PC clipboard" | "tmux buffer";
  preview: string;
  age: string;
};

type CustomKeyboardPopoverAnchor = {
  element: HTMLElement;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

type CustomKeyboardPopoverPlacement = {
  left: number;
  top: number;
  height: number;
};

type CustomKeyboardPopover = {
  kind: "profile" | "clipboard";
  anchor: CustomKeyboardPopoverAnchor;
} | null;

type CustomKeyboardModalViewport = {
  top: number;
  left: number;
  width: number;
  height: number;
};

function assertNeverCustomKeyboardActivation(value: never): never {
  throw new Error(`Unsupported custom keyboard activation: ${String(value)}`);
}

function readCustomKeyboardModalViewport(): CustomKeyboardModalViewport {
  if (typeof window === "undefined") return { top: 0, left: 0, width: 1, height: 1 };
  const visualViewport = window.visualViewport;
  const heightCandidates = [visualViewport?.height, window.innerHeight, document.documentElement.clientHeight].filter(
    (height): height is number => typeof height === "number" && height > 0,
  );
  const height = heightCandidates.length > 0 ? Math.min(...heightCandidates) : 1;

  return {
    top: visualViewport?.offsetTop ?? 0,
    left: visualViewport?.offsetLeft ?? 0,
    width: Math.max(1, visualViewport?.width ?? window.innerWidth),
    height,
  };
}

function useCustomKeyboardModalViewport(): CustomKeyboardModalViewport {
  const [viewport, setViewport] = useState<CustomKeyboardModalViewport>(readCustomKeyboardModalViewport);

  useLayoutEffect(() => {
    const updateViewport = () => setViewport(readCustomKeyboardModalViewport());
    const visualViewport = window.visualViewport;

    updateViewport();
    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);

    return () => {
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  return viewport;
}

function customKeyboardPopoverAnchor(element: HTMLElement): CustomKeyboardPopoverAnchor {
  const rect = element.getBoundingClientRect();
  return {
    element,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

export function CustomKeyboardView({
  viewModel,
  children,
  nativeKeyboard,
  onOpenSettings,
  clipboardHistory,
  onClipboardHistorySelect,
}: {
  viewModel: CustomKeyboardViewModel;
  children: ReactNode;
  nativeKeyboard?: ReactNode;
  onOpenSettings: () => void;
  clipboardHistory?: readonly CustomKeyboardClipboardHistoryEntry[];
  onClipboardHistorySelect?: (entry: CustomKeyboardClipboardHistoryEntry) => void;
}) {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const pendingNativeFileActionRef = useRef<CustomKeyboardNativeFileAction | null>(null);
  const [openPopover, setOpenPopover] = useState<CustomKeyboardPopover>(null);

  const togglePopover = useCallback((kind: Exclude<CustomKeyboardPopover, null>["kind"], anchor: HTMLElement) => {
    setOpenPopover((current) =>
      current?.kind === kind ? null : { kind, anchor: customKeyboardPopoverAnchor(anchor) },
    );
  }, []);

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

  const onKeyPress = useCallback(
    (key: CustomKeyboardKey, element?: HTMLElement) => {
      switch (key.activation.type) {
        case "surface":
          if (element) togglePopover(key.activation.surface, element);
          return;
        case "directional-flick":
          return;
        case "sequence":
        case "modifier":
        case "terminal":
          viewModel.onActivateKey(key);
          return;
        case "native":
          viewModel.onActivateKey(key);
          if (key.activation.action === "pick-photo" || key.activation.action === "capture-photo") {
            openNativeFilePicker(key.activation.action);
          }
          return;
        default:
          return assertNeverCustomKeyboardActivation(key.activation);
      }
    },
    [openNativeFilePicker, togglePopover, viewModel],
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
      <CustomKeyboardBar
        viewModel={viewModel}
        onKeyPress={onKeyPress}
        profilePickerOpen={openPopover?.kind === "profile"}
        clipboardMenuOpen={openPopover?.kind === "clipboard"}
        clipboardMenuAnchor={openPopover?.kind === "clipboard" ? openPopover.anchor : undefined}
        clipboardHistory={clipboardHistory}
        onClipboardHistorySelect={onClipboardHistorySelect}
        onClosePopover={() => setOpenPopover(null)}
      />
      {viewModel.nativeKeyboardVisible ? nativeKeyboard : null}
      {openPopover?.kind === "profile" && openPopover.anchor ? (
        <CustomKeyboardProfilePicker
          viewModel={viewModel}
          anchor={openPopover.anchor}
          onClose={() => setOpenPopover(null)}
          onOpenSettings={() => {
            setOpenPopover(null);
            onOpenSettings();
          }}
        />
      ) : null}
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
  onKeyPress = (key) => viewModel.onActivateKey(key),
  onKeepNativeKeyboardOpen = viewModel.onKeepNativeKeyboardOpen,
  profilePickerOpen,
  clipboardMenuOpen,
  clipboardMenuAnchor,
  clipboardHistory,
  onClipboardHistorySelect,
  onClosePopover,
}: {
  viewModel: CustomKeyboardViewModel;
  onKeyPress?: (key: CustomKeyboardKey, element?: HTMLElement) => void;
  onKeepNativeKeyboardOpen?: () => void;
  profilePickerOpen: boolean;
  clipboardMenuOpen: boolean;
  clipboardMenuAnchor?: CustomKeyboardPopoverAnchor;
  clipboardHistory?: readonly CustomKeyboardClipboardHistoryEntry[];
  onClipboardHistorySelect?: (entry: CustomKeyboardClipboardHistoryEntry) => void;
  onClosePopover: () => void;
}) {
  const clipboardSurface = viewModel.surfaces.find((surface) => surface.id === "clipboard");
  const clipboardKeys = clipboardSurface?.keys ?? [];

  return (
    <div
      className={`custom-keyboard-bar relative z-40 shrink-0 border-t border-[#1c4a28] bg-[rgb(5_15_8_/_98%)] pl-[max(5px,var(--safe-area-left))] pr-[max(5px,var(--safe-area-right))] pt-1 shadow-[0_-10px_24px_rgb(0_0_0_/_28%)] ${viewModel.nativeKeyboardVisible ? "custom-keyboard-bar--native" : "custom-keyboard-bar--custom"}`}
      role="toolbar"
      aria-label="Custom terminal keyboard"
    >
      <div className="mx-auto flex min-w-0 max-w-[1560px] flex-col items-stretch gap-0.5">
        {viewModel.rows.map((row) => (
          <CustomKeyboardLayoutRowView
            key={row.id}
            row={row}
            viewModel={viewModel}
            stableRow={row.overflow === "stable"}
            onKeyPress={onKeyPress}
            onKeepNativeKeyboardOpen={onKeepNativeKeyboardOpen}
            profilePickerOpen={profilePickerOpen}
            clipboardMenuOpen={clipboardMenuOpen}
          />
        ))}
      </div>
      {clipboardMenuOpen && clipboardMenuAnchor ? (
        <CustomKeyboardClipboardPicker
          keys={clipboardKeys}
          history={clipboardHistory}
          anchor={clipboardMenuAnchor}
          onSelect={(key) => {
            onKeyPress(key);
            onClosePopover();
          }}
          onHistorySelect={onClipboardHistorySelect}
          onClose={onClosePopover}
        />
      ) : null}
    </div>
  );
}

function CustomKeyboardLayoutRowView({
  row,
  viewModel,
  stableRow,
  onKeyPress,
  onKeepNativeKeyboardOpen,
  profilePickerOpen,
  clipboardMenuOpen,
}: {
  row: CustomKeyboardViewModel["rows"][number];
  viewModel: CustomKeyboardViewModel;
  stableRow: boolean;
  onKeyPress: (key: CustomKeyboardKey, element?: HTMLElement) => void;
  onKeepNativeKeyboardOpen: () => void;
  profilePickerOpen: boolean;
  clipboardMenuOpen: boolean;
}) {
  const scrollable = row.overflow === "scroll";
  return (
    <div
      className={`custom-keyboard-layout-row min-w-0 ${scrollable ? "overflow-x-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "w-full overflow-hidden"}`}
      data-custom-keyboard-row={row.id}
    >
      <div className={`flex items-stretch gap-0.5 ${scrollable ? "min-w-max" : "w-full min-w-0"}`}>
        {row.items.map((item) => (
          <CustomKeyboardButtonView
            key={item.key.id}
            button={item.key}
            compact={item.density === "compact"}
            flexGrow={item.flexGrow}
            stableRow={stableRow}
            active={
              item.key.activation.type === "modifier" &&
              viewModel.activeModifiers.includes(item.key.activation.modifier)
            }
            nativeKeyboardVisible={viewModel.nativeKeyboardVisible}
            surfaceOpen={
              item.key.activation.type === "surface" &&
              (item.key.activation.surface === "profile" ? profilePickerOpen : clipboardMenuOpen)
            }
            onPress={onKeyPress}
            onKeepNativeKeyboardOpen={onKeepNativeKeyboardOpen}
            onDirectionalFlick={viewModel.onDirectionalFlick}
            repeatStartDelayMs={viewModel.repeatStartDelayMs}
            repeatIntervalMs={viewModel.repeatIntervalMs}
          />
        ))}
      </div>
    </div>
  );
}

function CustomKeyboardPopoverFrame({
  anchor,
  align,
  className,
  children,
  "aria-label": ariaLabel,
  onClose,
}: {
  anchor: CustomKeyboardPopoverAnchor;
  align: "left" | "right";
  className: string;
  children: ReactNode;
  "aria-label": string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<CustomKeyboardPopoverPlacement | null>(null);

  const updatePlacement = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const viewportWidth = Math.max(1, window.visualViewport?.width ?? window.innerWidth);
    const viewportHeight = Math.max(1, window.visualViewport?.height ?? window.innerHeight);
    const currentAnchor = anchor.element.isConnected ? customKeyboardPopoverAnchor(anchor.element) : anchor;
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const preferredLeft = align === "right" ? currentAnchor.right - panelRect.width : currentAnchor.left;
    const maxLeft = Math.max(margin, viewportWidth - panelRect.width - margin);
    const left = Math.min(Math.max(preferredLeft, margin), maxLeft);
    const spaceAbove = Math.max(1, currentAnchor.top - gap - margin);
    const spaceBelow = Math.max(1, viewportHeight - currentAnchor.bottom - gap - margin);
    const placeAbove = panelRect.height <= spaceAbove || spaceAbove >= spaceBelow;
    const availableHeight = placeAbove ? spaceAbove : spaceBelow;
    const height = Math.max(1, Math.floor(availableHeight));
    const top = placeAbove
      ? Math.max(margin, currentAnchor.top - gap - Math.min(panelRect.height, height))
      : currentAnchor.bottom + gap;

    setPlacement({ left, top, height });
  }, [align, anchor]);

  useLayoutEffect(() => {
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.visualViewport?.addEventListener("resize", updatePlacement);
    window.visualViewport?.addEventListener("scroll", updatePlacement);
    const panel = panelRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePlacement);
    if (panel) resizeObserver?.observe(panel);

    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.visualViewport?.removeEventListener("resize", updatePlacement);
      window.visualViewport?.removeEventListener("scroll", updatePlacement);
      resizeObserver?.disconnect();
    };
  }, [updatePlacement]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || anchor.element.contains(target)) return;
      onClose();
    };

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, [anchor.element, onClose]);

  return (
    <AppSafeAreaOverlay className="pointer-events-none z-40">
      <div className="pointer-events-none relative h-full w-full" role="presentation">
        <section
          ref={panelRef}
          className={`pointer-events-auto fixed max-h-[min(62%,420px)] ${className}`}
          style={
            placement
              ? { left: `${placement.left}px`, top: `${placement.top}px`, maxHeight: `${placement.height}px` }
              : { left: "8px", top: "8px", visibility: "hidden" }
          }
          role="dialog"
          aria-label={ariaLabel}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {children}
        </section>
      </div>
    </AppSafeAreaOverlay>
  );
}

function CustomKeyboardClipboardPicker({
  keys,
  history,
  anchor,
  onSelect,
  onHistorySelect,
  onClose,
}: {
  keys: readonly CustomKeyboardKey[];
  history?: readonly CustomKeyboardClipboardHistoryEntry[];
  anchor: CustomKeyboardPopoverAnchor;
  onSelect: (key: CustomKeyboardKey) => void;
  onHistorySelect?: (entry: CustomKeyboardClipboardHistoryEntry) => void;
  onClose: () => void;
}) {
  const copyKey = keys.find((key) => key.activation.type === "terminal" && key.activation.action === "enter-copy-mode");
  const pasteKeys = keys.filter(
    (key) =>
      key.activation.type === "terminal" &&
      (key.activation.action === "paste-from-clipboard" || key.activation.action === "paste-from-tmux-buffer"),
  );
  return (
    <CustomKeyboardPopoverFrame
      anchor={anchor}
      align="left"
      className="flex w-[min(86vw,320px)] flex-col overflow-hidden rounded-[12px] border border-[#2b6838] bg-[#071509] shadow-[0_16px_50px_rgb(0_0_0_/_55%)]"
      aria-label="Copy and paste actions"
      onClose={onClose}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1d4325] px-3 py-2">
        <div className="min-w-0">
          <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
            Clipboard
          </span>
          <h2 className="m-0 mt-0.5 truncate text-[0.78rem] font-bold">Copy and paste</h2>
        </div>
        <button
          className="grid size-7 shrink-0 place-items-center rounded-[6px] border border-[#2d5d37] bg-[#0b2111] text-[#a9e8b1]"
          type="button"
          onClick={onClose}
          aria-label="Close copy and paste actions"
        >
          <AppIcon name="close" size={14} />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto p-2">
        <div className="grid gap-1">
          {copyKey ? (
            <ClipboardPopoverAction
              key={copyKey.id}
              button={copyKey}
              label="Copy mode"
              detail="Select text from the terminal"
              onSelect={onSelect}
            />
          ) : null}
          {pasteKeys.map((button) => (
            <ClipboardPopoverAction
              button={button}
              key={button.id}
              label={button.accessibleLabel}
              detail={
                button.activation.type === "terminal" && button.activation.action === "paste-from-clipboard"
                  ? "Use the device clipboard"
                  : "Use the tmux buffer"
              }
              onSelect={onSelect}
            />
          ))}
        </div>
        {history?.length ? (
          <div className="mt-2 border-t border-[#1d4325] pt-2">
            <div className="mb-1 px-1 font-mono text-[0.46rem] font-bold uppercase tracking-[0.12em] text-[#63ae6e]">
              History experiment
            </div>
            <div className="grid gap-1">
              {history.map((entry) => (
                <button
                  className="flex min-w-0 items-center gap-2 rounded-[7px] border border-[#244d2d] bg-[#0a1c0e] px-2 py-1.5 text-left text-[#b3eebc] hover:border-[#70c27b] hover:bg-[#102d17]"
                  key={entry.id}
                  type="button"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onHistorySelect?.(entry);
                    onClose();
                  }}
                  aria-label={`Use history entry ${entry.preview}`}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-[#0b2411]">
                    <CustomKeyboardIconView icon="clipboard" size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-[0.56rem] font-bold">{entry.preview}</strong>
                    <small className="block truncate text-[0.46rem] text-[#78ae80]">
                      {entry.source} · {entry.age}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </CustomKeyboardPopoverFrame>
  );
}

function ClipboardPopoverAction({
  button,
  label,
  detail,
  onSelect,
}: {
  button: CustomKeyboardKey;
  label: string;
  detail: string;
  onSelect: (button: CustomKeyboardKey) => void;
}) {
  return (
    <CustomKeyboardActionSurface
      className="flex min-h-10 min-w-0 items-center gap-2 rounded-[7px] border border-[#244d2d] bg-[#0a1c0e] px-2 text-left text-[#b3eebc] hover:border-[#70c27b] hover:bg-[#102d17]"
      onPress={() => onSelect(button)}
      aria-label={label}
      title={label}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-[#0b2411]">
        <CustomKeyboardIconView icon={button.icon ?? "clipboard"} size={14} />
      </span>
      <span className="min-w-0">
        <strong className="block truncate text-[0.58rem] font-bold">{label}</strong>
        <small className="block truncate text-[0.48rem] text-[#78ae80]">{detail}</small>
      </span>
    </CustomKeyboardActionSurface>
  );
}

function CustomKeyboardProfilePicker({
  viewModel,
  anchor,
  onClose,
  onOpenSettings,
}: {
  viewModel: CustomKeyboardViewModel;
  anchor: CustomKeyboardPopoverAnchor;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <CustomKeyboardPopoverFrame
      anchor={anchor}
      align="right"
      className="flex w-[min(88vw,330px)] flex-col overflow-hidden rounded-[12px] border border-[#2b6838] bg-[#071509] shadow-[0_16px_50px_rgb(0_0_0_/_55%)]"
      aria-label="Select custom keyboard profile"
      onClose={onClose}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1d4325] px-3 py-2.5">
        <div className="min-w-0">
          <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">Profile</span>
          <h2 className="m-0 mt-0.5 truncate text-[0.82rem] font-bold">Choose keyboard profile</h2>
        </div>
        <button
          className="grid size-8 shrink-0 place-items-center rounded-[7px] border border-[#2d5d37] bg-[#0b2111] text-[#a9e8b1]"
          type="button"
          onClick={onClose}
          aria-label="Close profile picker"
        >
          <AppIcon name="close" size={15} />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto p-2" role="listbox" aria-label="Custom keyboard profiles">
        <div className="grid gap-1.5">
          {viewModel.profiles.map((profile) => {
            const active = profile.id === viewModel.activeProfile.id;
            return (
              <button
                className={`flex min-h-11 items-center gap-2 rounded-[9px] border px-2.5 py-2 text-left transition-colors ${
                  active
                    ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                    : "border-[#245631] bg-[#0b1c0f] text-[#b3eebc] hover:border-[#4e9d5d] hover:bg-[#12351a]"
                }`}
                key={profile.id}
                type="button"
                onClick={() => {
                  viewModel.onSelectProfile(profile.id);
                  onClose();
                }}
                role="option"
                aria-selected={active}
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-[#0b2411]">
                  <CustomKeyboardIconView icon={profile.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[0.66rem]">{profile.name}</strong>
                  <small className="block truncate text-[0.52rem] text-[#78ae80]">
                    {profile.linked ? "Available in this workspace" : "Tap to add to this workspace"}
                  </small>
                </span>
                {active ? (
                  <span className="text-[0.8rem]" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-[#1d4325] px-2.5 py-2">
        <span className="min-w-0 truncate font-mono text-[0.48rem] text-[#628168]">
          {viewModel.workspaceId
            ? "Profiles are remembered for this workspace."
            : "Profiles are stored on this device."}
        </span>
        <button
          className="shrink-0 rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-2 py-1.5 font-mono text-[0.5rem] font-bold uppercase tracking-[0.05em] text-[#a9e8b1]"
          type="button"
          onClick={onOpenSettings}
        >
          Keyboard settings
        </button>
      </footer>
    </CustomKeyboardPopoverFrame>
  );
}

function CustomKeyboardActionSurface({
  className,
  style,
  children,
  onPress,
  onInteractionStart,
  preserveNativeKeyboardFocus = false,
  "aria-label": ariaLabel,
  title,
  "aria-pressed": ariaPressed,
  "aria-haspopup": ariaHaspopup,
  "aria-expanded": ariaExpanded,
}: {
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  onPress: (element: HTMLButtonElement) => void;
  onInteractionStart?: () => void;
  preserveNativeKeyboardFocus?: boolean;
  "aria-label": string;
  title: string;
  "aria-pressed"?: boolean;
  "aria-haspopup"?: "dialog" | "menu";
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      className={className}
      style={style}
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
      onClick={(event) => onPress(event.currentTarget)}
      aria-pressed={ariaPressed}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
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
  compact = false,
  flexGrow,
  stableRow = false,
  active,
  nativeKeyboardVisible = false,
  surfaceOpen = false,
  onPress,
  onKeepNativeKeyboardOpen,
  onDirectionalFlick,
  repeatStartDelayMs,
  repeatIntervalMs,
}: {
  button: CustomKeyboardKey;
  compact?: boolean;
  flexGrow?: number;
  stableRow?: boolean;
  active: boolean;
  nativeKeyboardVisible?: boolean;
  surfaceOpen?: boolean;
  onPress: (button: CustomKeyboardKey, element?: HTMLElement) => void;
  onKeepNativeKeyboardOpen: () => void;
  onDirectionalFlick: (direction: CustomKeyboardFlickDirection) => void;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
}) {
  if (button.activation.type === "directional-flick") {
    return (
      <CustomKeyboardDirectionalFlickButtonView
        button={button}
        compact={compact}
        flexGrow={flexGrow}
        stableRow={stableRow}
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
  const showIcon = icon !== undefined && (compact || !showValueAsPrimary);
  const compactLabel = compact
    ? (compactTerminalActionLabel(button) ?? button.label)
    : compactTerminalActionLabel(button);
  const isStandardKeyboardToggle =
    button.activation.type === "native" && button.activation.action === "toggle-standard-keyboard";
  const isFileAction =
    button.activation.type === "native" &&
    (button.activation.action === "pick-photo" || button.activation.action === "capture-photo");
  const accessibleLabel = isStandardKeyboardToggle
    ? nativeKeyboardVisible
      ? "Hide standard keyboard"
      : "Show standard keyboard"
    : button.accessibleLabel;

  return (
    <CustomKeyboardActionSurface
      className={`${compact ? "custom-keyboard-compact-button " : "custom-keyboard-key-button "}group relative flex h-[34px] min-w-0 shrink-0 flex-col items-center justify-center gap-0 overflow-hidden rounded-[6px] border px-1 font-mono transition-[border-color,background-color,transform] active:scale-[0.97] ${
        isStandardKeyboardToggle && nativeKeyboardVisible
          ? "border-[#78b7ff] bg-[#123052] text-[#a9d5ff]"
          : active || surfaceOpen
            ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd] shadow-[0_0_0_2px_rgb(139_255_154_/_14%)]"
            : button.category === "shortcuts"
              ? "border-[#315d88] bg-[#0d2237] text-[#a8d7ff] hover:border-[#5a9dd3] hover:bg-[#123452]"
              : "border-[#245631] bg-[#0b1c0f] text-[#b3eebc] hover:border-[#4e9d5d] hover:bg-[#12351a]"
      }`}
      style={customKeyboardKeyFlexStyle(flexGrow, stableRow)}
      onPress={(element) => onPress(button, element)}
      onInteractionStart={isFileAction ? undefined : onKeepNativeKeyboardOpen}
      preserveNativeKeyboardFocus={!isFileAction}
      aria-pressed={
        button.activation.type === "modifier" ? active : isStandardKeyboardToggle ? nativeKeyboardVisible : undefined
      }
      aria-haspopup={button.activation.type === "surface" ? "dialog" : undefined}
      aria-expanded={button.activation.type === "surface" ? surfaceOpen : undefined}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {showIcon ? (
        <span
          className={`${button.category === "special" ? "text-[0.58rem]" : "text-[0.7rem]"} font-bold leading-none tracking-[-0.06em]`}
          aria-hidden="true"
        >
          <CustomKeyboardIconView icon={icon} size={compactLabel ? 16 : 15} />
        </span>
      ) : null}
      {compactLabel ? (
        <span
          className="max-w-full truncate text-[0.42rem] font-bold uppercase leading-none tracking-[0.02em]"
          aria-hidden="true"
        >
          {compactLabel}
        </span>
      ) : null}
      {!compact && showValueAsPrimary ? (
        <span
          className={`max-w-full font-bold leading-none ${button.category === "special" ? "whitespace-nowrap text-[0.4rem] tracking-[-0.04em]" : "truncate text-[0.78rem]"}`}
        >
          {valueLabel}
        </span>
      ) : !compact && displayLabel ? (
        <span className="max-w-[38px] truncate text-[0.4rem] font-bold leading-none">{displayLabel}</span>
      ) : null}
      {button.category === "shortcuts" ? (
        <span className="absolute right-0.5 top-0.5 size-0.5 rounded-full bg-[#72c8ff] opacity-80" aria-hidden="true" />
      ) : null}
    </CustomKeyboardActionSurface>
  );
}

function customKeyboardKeyFlexStyle(flexGrow: number | undefined, stableRow: boolean): CSSProperties | undefined {
  if (flexGrow !== undefined) {
    return { flex: `${flexGrow} 1 0%`, width: "auto", minWidth: 0, maxWidth: "none" };
  }
  return stableRow ? { flex: "0 1 34px", minWidth: 0 } : undefined;
}

function CustomKeyboardDirectionalFlickButtonView({
  button,
  compact = false,
  flexGrow,
  stableRow = false,
  onDirection,
  onKeepNativeKeyboardOpen,
  repeatStartDelayMs,
  repeatIntervalMs,
}: {
  button: CustomKeyboardKey;
  compact?: boolean;
  flexGrow?: number;
  stableRow?: boolean;
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
      className={`${compact ? "custom-keyboard-compact-button" : "custom-keyboard-key-button"} group relative grid h-[34px] shrink-0 place-items-center rounded-[6px] border px-1 font-mono transition-[border-color,background-color,transform] active:scale-[0.97] ${
        preview
          ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd] shadow-[0_0_0_2px_rgb(139_255_154_/_14%)]"
          : "border-[#245631] bg-[#0b1c0f] text-[#b3eebc] hover:border-[#4e9d5d] hover:bg-[#12351a]"
      }`}
      style={{ ...customKeyboardKeyFlexStyle(flexGrow, stableRow), touchAction: "none" }}
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
        {preview
          ? `${preview.repeating ? "Repeating" : "Sending"} ${preview.direction} arrow`
          : "Arrow pad: swipe or hold"}
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
  const [dropTargetButtonId, setDropTargetButtonId] = useState<string | null>(null);
  const [dropTargetRowId, setDropTargetRowId] = useState<string | null>(null);
  const [shortcutDropIndicator, setShortcutDropIndicator] = useState<ShortcutDropIndicator | null>(null);
  const [previewDropActive, setPreviewDropActive] = useState(false);
  const [activeTab, setActiveTab] = useState<CustomKeyboardKeyCategory>("abc");
  const [abcShiftActive, setAbcShiftActive] = useState(false);
  const [numberShiftActive, setNumberShiftActive] = useState(false);
  const [showFlickSettings, setShowFlickSettings] = useState(false);
  const [shortcutModalOpen, setShortcutModalOpen] = useState(false);
  const [shortcutEditMode, setShortcutEditMode] = useState(false);
  const [editingShortcutId, setEditingShortcutId] = useState<string | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<CustomKeyboardShortcutDraft>(() => createShortcutDraft());
  const [profileNameDraft, setProfileNameDraft] = useState(viewModel.activeProfile.name);
  const [profileIconDraft, setProfileIconDraft] = useState<CustomKeyboardIcon>(viewModel.activeProfile.icon);
  const [profileModal, setProfileModal] = useState<"create" | "edit" | null>(null);
  const [newProfileName, setNewProfileName] = useState("New profile");
  const [newProfileIcon, setNewProfileIcon] = useState<CustomKeyboardIcon>("terminal");
  const activeProfile = viewModel.activeProfile;
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: CUSTOM_KEYBOARD_MOUSE_DRAG_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: CUSTOM_KEYBOARD_TOUCH_DRAG_DELAY_MS,
        tolerance: CUSTOM_KEYBOARD_TOUCH_DRAG_TOLERANCE_PX,
      },
    }),
  );
  const dndSessionRef = useRef<CustomKeyboardDndSession | null>(null);

  useEffect(() => {
    setProfileNameDraft(activeProfile.name);
    setProfileIconDraft(activeProfile.icon);
  }, [activeProfile]);

  const addButton = useCallback(
    (button: CustomKeyboardKey) => {
      viewModel.onDrop(
        { keyId: button.id, collection: "library" },
        { type: "keyboard", rowId: viewModel.rows[0]?.id ?? "main", targetKeyId: null },
      );
    },
    [viewModel],
  );

  const addButtonFromClick = addButton;

  const resetDrag = useCallback(() => {
    dndSessionRef.current = null;
    setDraggedButtonId(null);
    setDropTargetButtonId(null);
    setDropTargetRowId(null);
    setShortcutDropIndicator(null);
    setPreviewDropActive(false);
  }, []);

  const commitDrop = useCallback(
    (
      source: CustomKeyboardDragSource,
      targetRowId: string | null,
      targetKeyId: string | null,
      targetIndex: number | null,
      overPreview: boolean,
    ) => {
      if (shortcutEditMode && (overPreview || targetIndex === null)) {
        resetDrag();
        return;
      }
      if (!shortcutEditMode && !overPreview) {
        resetDrag();
        return;
      }
      const target: CustomKeyboardDropTarget =
        shortcutEditMode && activeTab === "shortcuts" && targetIndex !== null
          ? { type: "shortcut-library", targetIndex }
          : {
              type: "keyboard",
              rowId: targetRowId ?? viewModel.rows[0]?.id ?? "main",
              targetKeyId: targetKeyId ?? null,
            };
      viewModel.onDrop(source, target);
      resetDrag();
    },
    [activeTab, resetDrag, shortcutEditMode, viewModel],
  );

  const updateDndDropTarget = useCallback(
    (session: CustomKeyboardDndSession, over: DragOverEvent["over"]) => {
      const target = readCustomKeyboardDndDropTarget(over);
      const isPreviewTarget =
        target?.kind === "preview" || target?.kind === "preview-row" || target?.kind === "preview-key";
      const targetRowId = target?.kind === "preview-row" || target?.kind === "preview-key" ? target.rowId : null;
      const targetKeyId = target?.kind === "preview-key" ? target.targetKeyId : null;
      const targetIndex =
        shortcutEditMode && activeTab === "shortcuts" && target?.kind === "shortcut-library"
          ? target.targetIndex
          : null;
      const overPreview = !shortcutEditMode && isPreviewTarget;

      session.targetRowId = targetRowId;
      session.targetKeyId = targetKeyId;
      session.targetIndex = targetIndex;
      session.overPreview = overPreview;
      setDropTargetButtonId(targetKeyId);
      setDropTargetRowId(targetRowId);
      setShortcutDropIndicator(session.targetIndex === null ? null : { index: session.targetIndex });
      setPreviewDropActive(overPreview);
    },
    [activeTab, shortcutEditMode],
  );

  const handleDndDragStart = useCallback(
    (event: DragStartEvent) => {
      const source = readCustomKeyboardDragSource(event.active);
      if (!source) return;

      resetDrag();
      dndSessionRef.current = {
        source,
        moved: false,
        targetRowId: null,
        targetKeyId: null,
        targetIndex: null,
        overPreview: false,
      };
      setDraggedButtonId(source.keyId);
      setDropTargetButtonId(null);
      setDropTargetRowId(null);
      setShortcutDropIndicator(null);
      setPreviewDropActive(false);
    },
    [resetDrag],
  );

  const handleDndDragMove = useCallback((event: DragMoveEvent) => {
    const session = dndSessionRef.current;
    if (!session) return;

    session.moved = session.moved || event.delta.x !== 0 || event.delta.y !== 0;
  }, []);

  const handleDndDragOver = useCallback(
    (event: DragOverEvent) => {
      const session = dndSessionRef.current;
      if (!session) return;
      updateDndDropTarget(session, event.over);
    },
    [updateDndDropTarget],
  );

  const handleDndDragEnd = useCallback(
    (event: DragEndEvent) => {
      const session = dndSessionRef.current;
      if (!session) return;

      const moved = session.moved || event.delta.x !== 0 || event.delta.y !== 0;
      if (!moved) {
        resetDrag();
        return;
      }

      updateDndDropTarget(session, event.over);
      commitDrop(session.source, session.targetRowId, session.targetKeyId, session.targetIndex, session.overPreview);
    },
    [commitDrop, resetDrag, updateDndDropTarget],
  );

  const handleDndDragCancel = useCallback(() => {
    resetDrag();
  }, [resetDrag]);

  const openShortcutModal = (button?: CustomKeyboardKey) => {
    setEditingShortcutId(button?.id ?? null);
    setShortcutDraft(
      button && button.activation.type === "sequence"
        ? { icon: button.icon ?? "shortcut", sequence: button.activation.sequence }
        : createShortcutDraft(),
    );
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

  const openProfileCreateModal = () => {
    setNewProfileName("New profile");
    setNewProfileIcon("terminal");
    setProfileModal("create");
  };

  const openProfileEditModal = () => {
    setProfileNameDraft(activeProfile.name);
    setProfileIconDraft(activeProfile.icon);
    setProfileModal("edit");
  };

  const closeProfileModal = () => {
    setProfileModal(null);
  };

  const saveProfile = () => {
    if (profileModal === "create") {
      if (!isCustomKeyboardProfileNameValid(newProfileName)) return;
      viewModel.onCreateProfile({ name: newProfileName, icon: newProfileIcon });
      closeProfileModal();
      return;
    }
    if (profileModal !== "edit") return;
    if (activeProfile.id !== DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID) {
      if (!isCustomKeyboardProfileNameValid(profileNameDraft)) return;
      viewModel.onRenameProfile(activeProfile.id, profileNameDraft);
      viewModel.onSetProfileIcon(activeProfile.id, profileIconDraft);
    }
    closeProfileModal();
  };

  const duplicateActiveProfile = () => {
    viewModel.onDuplicateProfile(activeProfile.id);
    closeProfileModal();
  };

  const deleteActiveProfile = () => {
    if (activeProfile.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID) return;
    if (!window.confirm(`Delete profile "${activeProfile.name}"?`)) return;
    viewModel.onDeleteProfile(activeProfile.id);
    closeProfileModal();
  };

  const assignedKeyIds = new Set(viewModel.assignedKeyIds);
  const editableRows = viewModel.rows.filter((row) => row.id === CUSTOM_KEYBOARD_EDITABLE_ROW_ID);
  const layoutKeys = editableRows.flatMap((row) => row.items.map((item) => item.key));
  const allKeys = [...layoutKeys, ...viewModel.availableKeys];
  const categoryButtons = Array.from(
    new Map(allKeys.filter((key) => key.category === activeTab).map((key) => [key.id, key] as const)).values(),
  );
  const pointerDraggedButton = draggedButtonId ? allKeys.find((key) => key.id === draggedButtonId) : null;
  const draggingShortcutCard =
    activeTab === "shortcuts" && shortcutEditMode && pointerDraggedButton?.category === "shortcuts";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={customKeyboardCollisionDetection}
      autoScroll={false}
      onDragStart={handleDndDragStart}
      onDragMove={handleDndDragMove}
      onDragOver={handleDndDragOver}
      onDragEnd={handleDndDragEnd}
      onDragCancel={handleDndDragCancel}
    >
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
          className="shrink-0 border-b border-[#1d4927] bg-[rgb(7_20_10_/_94%)] px-3 py-2"
          aria-label="Keyboard profiles"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
              Profile
            </span>
            <label className="min-w-0 flex-1">
              <span className="sr-only">Keyboard profile</span>
              <select
                className="min-h-9 w-full min-w-0 rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-2 font-mono text-[0.58rem] font-bold text-[#d9ffdd] outline-none focus:border-[#8bff9a]"
                value={activeProfile.id}
                onChange={(event) => viewModel.onSelectProfile(event.target.value)}
                aria-label="Keyboard profile"
              >
                {viewModel.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="grid size-9 shrink-0 place-items-center rounded-[7px] border border-[#315f3a] bg-[#0b2411] text-[#a9e8b1] hover:border-[#8bff9a]"
              type="button"
              onClick={openProfileEditModal}
              aria-label="Edit keyboard profile"
              title="Edit keyboard profile"
            >
              <AppIcon name="edit" size={15} />
            </button>
            <button
              className="grid size-9 shrink-0 place-items-center rounded-[7px] border border-[#315f3a] bg-[#0b2411] text-[#a9e8b1] hover:border-[#8bff9a]"
              type="button"
              onClick={openProfileCreateModal}
              aria-label="Add keyboard profile"
              title="Add keyboard profile"
            >
              <AppIcon name="plus" size={15} />
            </button>
            {viewModel.workspaceId && activeProfile.id !== DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID ? (
              <button
                className={`min-h-9 shrink-0 rounded-[7px] border px-2 font-mono text-[0.44rem] font-bold uppercase tracking-[0.04em] ${
                  activeProfile.linked
                    ? "border-[#4a9a57] bg-[#12351a] text-[#baffc1]"
                    : "border-[#315f3a] bg-[#071509] text-[#719176]"
                }`}
                type="button"
                onClick={() => viewModel.onToggleProfileLink(activeProfile.id)}
                aria-pressed={activeProfile.linked}
                title={activeProfile.linked ? "Remove profile from workspace" : "Add profile to workspace"}
              >
                {activeProfile.linked ? "Linked" : "Link"}
              </button>
            ) : null}
          </div>
          <p className="m-0 mt-1 truncate font-mono text-[0.48rem] leading-[1.4] text-[#628168]">
            {viewModel.workspaceId
              ? "Choose the profile for this workspace. Use edit or add to manage profiles."
              : "Profiles are stored locally on this device."}
          </p>
        </section>

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
          <CustomKeyboardPreviewDropZone
            active={previewDropActive}
            disabled={shortcutEditMode}
            dragging={draggedButtonId !== null}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {editableRows.map((row) => (
                <CustomKeyboardPreviewRow
                  key={row.id}
                  row={row}
                  draggedButtonId={draggedButtonId}
                  dropTargetButtonId={dropTargetButtonId}
                  dropTargetRowId={dropTargetRowId}
                  previewDropActive={previewDropActive}
                  dragEnabled={!shortcutEditMode}
                  onRemove={(keyId) => viewModel.onRemoveKey(keyId)}
                />
              ))}
            </div>
          </CustomKeyboardPreviewDropZone>
          {showFlickSettings ? (
            <div className="mt-2 rounded-[8px] border border-[#285a33] bg-[#071509] p-2">
              <p className="m-0 text-[0.54rem] text-[#719176]">
                Swipe or hold the arrow pad to repeat the arrow input at the selected interval.
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
              dropIndicator={shortcutDropIndicator}
            />
          ) : (
            <CustomKeyboardButtonLibrary
              buttons={categoryButtons}
              assignedKeyIds={assignedKeyIds}
              category={activeTab}
              shiftActive={abcShiftActive}
              onToggleShift={() => setAbcShiftActive((current) => !current)}
              numberShiftActive={numberShiftActive}
              onToggleNumberShift={() => setNumberShiftActive((current) => !current)}
              onAddButton={addButtonFromClick}
              draggedButtonId={draggedButtonId}
            />
          )}
        </div>
        {profileModal ? (
          <CustomKeyboardProfileModal
            mode={profileModal}
            name={profileModal === "edit" ? profileNameDraft : newProfileName}
            icon={profileModal === "edit" ? profileIconDraft : newProfileIcon}
            isDefault={profileModal === "edit" && activeProfile.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID}
            onNameChange={profileModal === "edit" ? setProfileNameDraft : setNewProfileName}
            onIconChange={profileModal === "edit" ? setProfileIconDraft : setNewProfileIcon}
            onClose={closeProfileModal}
            onSubmit={saveProfile}
            onDuplicate={profileModal === "edit" ? duplicateActiveProfile : undefined}
            onDelete={profileModal === "edit" ? deleteActiveProfile : undefined}
          />
        ) : null}
        {shortcutModalOpen ? (
          <CustomKeyboardShortcutRegistrationModal
            draft={shortcutDraft}
            mode={editingShortcutId ? "edit" : "create"}
            onChange={setShortcutDraft}
            onClose={closeShortcutModal}
            onSubmit={saveShortcut}
          />
        ) : null}
      </main>
      <DragOverlay dropAnimation={null} zIndex={50} className="pointer-events-none">
        {pointerDraggedButton ? (
          <CustomKeyboardDragPreview button={pointerDraggedButton} shortcutCard={draggingShortcutCard} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const customKeyboardSettingsTabs: readonly { value: CustomKeyboardKeyCategory; label: string }[] = [
  { value: "abc", label: "ABC" },
  { value: "123", label: "123" },
  { value: "special", label: "Special" },
  { value: "shortcuts", label: "Shortcuts" },
];

function isCustomKeyboardDragCollection(value: string): value is CustomKeyboardDragSource["collection"] {
  return value === "keyboard" || value === "library" || value === "shortcut-library";
}

function readCustomKeyboardDragSource(active: DragStartEvent["active"]): CustomKeyboardDragSource | null {
  const value = active.data.current?.customKeyboardSource;
  if (!value || typeof value !== "object") return null;

  const candidate = value as { keyId?: unknown; collection?: unknown; rowId?: unknown };
  if (
    typeof candidate.keyId !== "string" ||
    typeof candidate.collection !== "string" ||
    !isCustomKeyboardDragCollection(candidate.collection)
  ) {
    return null;
  }

  return {
    keyId: candidate.keyId,
    collection: candidate.collection,
    ...(typeof candidate.rowId === "string" ? { rowId: candidate.rowId } : {}),
  };
}

function readCustomKeyboardDndDropTarget(over: DragOverEvent["over"]): CustomKeyboardDndDropTarget | null {
  const value = over?.data.current?.customKeyboardDropTarget;
  if (!value || typeof value !== "object") return null;

  const candidate = value as {
    kind?: unknown;
    rowId?: unknown;
    targetKeyId?: unknown;
    targetIndex?: unknown;
  };
  if (candidate.kind === "preview") return { kind: "preview" };
  if (candidate.kind === "preview-row" && typeof candidate.rowId === "string") {
    return { kind: "preview-row", rowId: candidate.rowId };
  }
  if (
    candidate.kind === "preview-key" &&
    typeof candidate.rowId === "string" &&
    typeof candidate.targetKeyId === "string"
  ) {
    return { kind: "preview-key", rowId: candidate.rowId, targetKeyId: candidate.targetKeyId };
  }
  if (
    candidate.kind === "shortcut-library" &&
    typeof candidate.targetIndex === "number" &&
    Number.isInteger(candidate.targetIndex) &&
    candidate.targetIndex >= 0
  ) {
    return { kind: "shortcut-library", targetIndex: candidate.targetIndex };
  }
  return null;
}

function createShortcutDraft(): CustomKeyboardShortcutDraft {
  return {
    icon: "shortcut",
    sequence: [],
  };
}

function CustomKeyboardPreviewDropZone({
  active,
  disabled,
  dragging,
  children,
}: {
  active: boolean;
  disabled: boolean;
  dragging: boolean;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: "custom-keyboard-preview",
    data: { customKeyboardDropTarget: { kind: "preview" } },
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      className={`mt-2 flex min-h-[52px] min-w-0 items-center gap-1 rounded-[9px] border border-dashed bg-[#061008] p-1.5 transition-colors ${
        dragging ? "overflow-x-hidden touch-none" : "overflow-x-auto touch-pan-x"
      } ${active ? "border-[#8bff9a] bg-[#102d17]" : "border-[#386e43]"}`}
      role="toolbar"
      aria-label="Custom keyboard preview drop zone"
      aria-disabled={disabled}
    >
      {children}
    </div>
  );
}

function CustomKeyboardPreviewRow({
  row,
  draggedButtonId,
  dropTargetButtonId,
  dropTargetRowId,
  previewDropActive,
  dragEnabled,
  onRemove,
}: {
  row: CustomKeyboardSettingsViewModel["rows"][number];
  draggedButtonId: string | null;
  dropTargetButtonId: string | null;
  dropTargetRowId: string | null;
  previewDropActive: boolean;
  dragEnabled: boolean;
  onRemove: (keyId: string) => void;
}) {
  const { setNodeRef } = useDroppable({
    id: `custom-keyboard-preview-row:${row.id}`,
    data: { customKeyboardDropTarget: { kind: "preview-row", rowId: row.id } },
    disabled: !dragEnabled,
  });

  return (
    <fieldset
      className="m-0 flex min-w-0 items-center gap-1 overflow-x-auto border-0 p-0 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      ref={setNodeRef}
    >
      {row.items.map((item) => (
        <CustomKeyboardPreviewButton
          key={item.key.id}
          button={item.key}
          source={{ keyId: item.key.id, collection: "keyboard", rowId: row.id }}
          assigned
          dragging={item.key.id === draggedButtonId}
          dropTarget={row.id === dropTargetRowId && item.key.id === dropTargetButtonId}
          dragEnabled={dragEnabled}
          onRemove={() => onRemove(item.key.id)}
        />
      ))}
      <span
        className={`flex h-[34px] min-w-[92px] shrink-0 items-center justify-center rounded-[6px] border border-dashed px-2 font-mono text-[0.48rem] transition-colors ${
          previewDropActive && dropTargetRowId === row.id
            ? "border-[#8bff9a] text-[#baffc1]"
            : "border-[#2a5c36] text-[#628168]"
        }`}
      >
        Drag keys here
      </span>
    </fieldset>
  );
}

function CustomKeyboardPreviewButton({
  button,
  source,
  assigned,
  dragging,
  dropTarget,
  dragEnabled,
  onRemove,
}: {
  button: CustomKeyboardKey;
  source: CustomKeyboardDragSource;
  assigned: boolean;
  dragging: boolean;
  dropTarget: boolean;
  dragEnabled: boolean;
  onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
    setActivatorNodeRef,
  } = useDraggable({
    id: `custom-keyboard-preview:${button.id}`,
    data: { customKeyboardSource: source },
    disabled: !dragEnabled,
  });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: `custom-keyboard-preview-key:${source.rowId ?? "main"}:${button.id}`,
    data: {
      customKeyboardDropTarget: {
        kind: "preview-key",
        rowId: source.rowId ?? "main",
        targetKeyId: button.id,
      },
    },
    disabled: !dragEnabled,
  });
  const setNodeRef = useCallback(
    (element: HTMLElement | null) => {
      setDraggableNodeRef(element);
      setDroppableNodeRef(element);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
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
      ref={setNodeRef}
    >
      {dropTarget ? (
        <span
          className="pointer-events-none absolute -bottom-1 -left-[3px] -top-1 z-10 w-0.5 rounded-full bg-[#8bff9a] shadow-[0_0_8px_rgb(139_255_154_/_75%)]"
          aria-hidden="true"
        />
      ) : null}
      <button
        className="flex min-w-0 flex-1 self-stretch appearance-none flex-col items-center justify-center border-0 bg-transparent p-0 font-mono text-[#c5ffcb]"
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        aria-label={button.accessibleLabel}
      >
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
      </button>
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
  assignedKeyIds,
  category,
  shiftActive,
  onToggleShift,
  numberShiftActive,
  onToggleNumberShift,
  onAddButton,
  draggedButtonId,
}: {
  buttons: readonly CustomKeyboardKey[];
  assignedKeyIds: ReadonlySet<string>;
  category: Exclude<CustomKeyboardKeyCategory, "shortcuts">;
  shiftActive: boolean;
  onToggleShift: () => void;
  numberShiftActive: boolean;
  onToggleNumberShift: () => void;
  onAddButton: (button: CustomKeyboardKey) => void;
  draggedButtonId: string | null;
}) {
  const buttonsByLabel = new Map<string, CustomKeyboardKey>();
  for (const button of buttons) {
    const label = keyboardButtonDisplayLabel(button);
    if (label && !buttonsByLabel.has(label.toLowerCase())) buttonsByLabel.set(label.toLowerCase(), button);
  }
  const shiftButton = buttons.find(
    (button) => button.activation.type === "modifier" && button.activation.modifier === "shift",
  );

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
        assigned={assignedKeyIds.has(button.id)}
        dragged={draggedButtonId === button.id}
        displayLabel={shiftActive && category === "abc" ? label.toUpperCase() : label}
        onAddButton={onAddButton}
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
        <span className="font-mono text-[0.5rem] text-[#6f9d76]">Tap to add · hold, then drag to preview</span>
      </div>
      {category === "abc" ? (
        <div className="mt-3 flex flex-col gap-1.5">
          {renderRow(customKeyboardAbcRows[0])}
          {renderRow(customKeyboardAbcRows[1], "px-[4%]")}
          <div className="mx-auto flex w-full max-w-[520px] gap-1.5">
            {shiftButton ? (
              <CustomKeyboardLibraryKey
                button={shiftButton}
                assigned={assignedKeyIds.has(shiftButton.id)}
                dragged={draggedButtonId === shiftButton.id}
                displayLabel="⇧"
                isShiftKey
                shiftActive={shiftActive}
                onAddButton={onAddButton}
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
              assigned={assignedKeyIds.has(button.id)}
              dragged={draggedButtonId === button.id}
              displayLabel={specialLibraryDisplayLabel(button)}
              displayIcon
              onAddButton={onAddButton}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function keyboardButtonDisplayLabel(button: CustomKeyboardKey): string | undefined {
  if (button.category === "shortcuts") return shortcutDisplayLabel(button);
  if (button.category === "special") return specialLibraryDisplayLabel(button);
  return keyboardButtonValueLabel(button);
}

function keyboardButtonValueLabel(button: CustomKeyboardKey): string | undefined {
  if (button.category === "shortcuts" || button.activation.type !== "sequence") return undefined;
  if (button.category === "abc" || button.category === "123" || !button.icon) {
    if (button.label) return button.label;
    const [token] = button.activation.sequence;
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
  onToggleShift,
}: {
  button: CustomKeyboardKey;
  assigned: boolean;
  dragged: boolean;
  displayLabel: string;
  isShiftKey?: boolean;
  shiftActive?: boolean;
  displayIcon?: boolean;
  onAddButton: (button: CustomKeyboardKey) => void;
  onToggleShift?: () => void;
}) {
  const source: CustomKeyboardDragSource = {
    keyId: button.id,
    collection: assigned ? "keyboard" : "library",
  };
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `custom-keyboard-library:${button.id}`,
    data: { customKeyboardSource: source },
  });

  return (
    <button
      className={[
        "relative grid h-[38px] min-w-0 flex-1 place-items-center rounded-[6px] border font-sans text-[0.68rem] font-semibold transition-colors",
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
      ref={setNodeRef}
      {...attributes}
      {...listeners}
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

function CustomKeyboardShortcutDropZone({
  index,
  active,
  disabled,
}: {
  index: number;
  active: boolean;
  disabled: boolean;
}) {
  const { setNodeRef } = useDroppable({
    id: `custom-keyboard-shortcut-drop:${index}`,
    data: { customKeyboardDropTarget: { kind: "shortcut-library", targetIndex: index } },
    disabled,
  });

  return (
    <button
      className="relative h-2 w-full appearance-none border-0 bg-transparent p-0"
      ref={setNodeRef}
      type="button"
      aria-label={`Insert shortcut at position ${index + 1}`}
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
}

function CustomKeyboardShortcutLibrary({
  viewModel,
  editMode,
  onToggleEditMode,
  onRegisterShortcut,
  onEditShortcut,
  draggedButtonId,
  dropIndicator,
}: {
  viewModel: CustomKeyboardSettingsViewModel;
  editMode: boolean;
  onToggleEditMode: () => void;
  onRegisterShortcut: () => void;
  onEditShortcut: (button: CustomKeyboardKey) => void;
  draggedButtonId: string | null;
  dropIndicator: ShortcutDropIndicator | null;
}) {
  const shortcuts = viewModel.shortcutKeys;

  const renderDropZone = (index: number) => {
    const active = editMode && dropIndicator?.index === index && draggedButtonId !== null;
    return (
      <CustomKeyboardShortcutDropZone
        key={`shortcut-drop-${index}`}
        index={index}
        active={active}
        disabled={!editMode}
      />
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
          const assigned = viewModel.assignedKeyIds.includes(button.id);
          return (
            <Fragment key={button.id}>
              {renderDropZone(index)}
              <CustomKeyboardShortcutCard
                button={button}
                assigned={assigned}
                editMode={editMode}
                dragged={draggedButtonId === button.id}
                onEditShortcut={onEditShortcut}
                onDeleteShortcut={() => viewModel.onDeleteShortcut(button.id)}
              />
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

function CustomKeyboardShortcutCard({
  button,
  assigned,
  editMode,
  dragged,
  onEditShortcut,
  onDeleteShortcut,
}: {
  button: CustomKeyboardKey;
  assigned: boolean;
  editMode: boolean;
  dragged: boolean;
  onEditShortcut: (button: CustomKeyboardKey) => void;
  onDeleteShortcut: () => void;
}) {
  const source: CustomKeyboardDragSource = {
    keyId: button.id,
    collection: editMode ? "shortcut-library" : assigned ? "keyboard" : "library",
  };
  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({
    id: `custom-keyboard-shortcut:${button.id}`,
    data: { customKeyboardSource: source },
  });
  const canReorder = editMode;

  return (
    <fieldset
      className={[
        "flex min-w-0 items-center gap-1.5 rounded-[8px] border p-1.5 transition-[border-color,box-shadow,opacity,transform]",
        canReorder ? "cursor-grab active:cursor-grabbing" : "cursor-default",
        assigned ? "border-[#4a8d55] bg-[#12351a]" : "border-dashed border-[#2e6540] bg-[#0a1c0e]",
        dragged ? "scale-[1.01] opacity-45 shadow-[0_8px_20px_rgb(0_0_0_/_28%)]" : "",
      ].join(" ")}
      ref={setNodeRef}
      {...attributes}
      {...(!canReorder ? (listeners ?? {}) : {})}
      aria-label={button.accessibleLabel}
    >
      {canReorder ? (
        <span
          className="mr-0.5 shrink-0 cursor-grab select-none px-0.5 text-[0.52rem] leading-none text-[#5d8b65]"
          ref={setActivatorNodeRef}
          {...(listeners ?? {})}
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
          <strong className="block truncate text-[0.62rem] text-[#c9f6ce]">{shortcutDisplayLabel(button)}</strong>
          <code className="mt-0.5 block truncate font-mono text-[0.54rem] text-[#6e9c75]">
            {formatSequence(keySequence(button))}
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
            onClick={onDeleteShortcut}
            aria-label={`Delete ${button.accessibleLabel}`}
          >
            ×
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function CustomKeyboardDragPreview({ button, shortcutCard }: { button: CustomKeyboardKey; shortcutCard: boolean }) {
  return (
    <div
      className={`pointer-events-none rounded-[9px] border border-[#8bff9a] bg-[#194d25]/95 font-mono text-[#d9ffdd] shadow-[0_12px_30px_rgb(0_0_0_/_42%)] ${
        shortcutCard
          ? "flex w-[min(260px,calc(100vw-24px))] items-center gap-2 p-2"
          : "flex size-[48px] flex-col items-center justify-center"
      }`}
      aria-hidden="true"
    >
      {button.icon ? (
        <span
          className={
            shortcutCard
              ? "grid size-9 shrink-0 place-items-center rounded-[7px] bg-[#0d2237] text-[0.86rem]"
              : "text-[0.86rem] font-bold leading-none"
          }
        >
          <CustomKeyboardIconView icon={button.icon} />
        </span>
      ) : null}
      {shortcutCard ? (
        <span className="min-w-0 flex-1">
          <strong className="block truncate text-[0.62rem]">{shortcutDisplayLabel(button)}</strong>
          <code className="mt-0.5 block truncate text-[0.52rem] text-[#8fc998]">
            {formatSequence(keySequence(button))}
          </code>
        </span>
      ) : (
        <span className="max-w-[42px] truncate text-[0.42rem] leading-none">
          {button.category === "shortcuts" ? shortcutDisplayLabel(button) : (button.label ?? "key")}
        </span>
      )}
    </div>
  );
}

function CustomKeyboardIconPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: CustomKeyboardIcon;
  onChange: (icon: CustomKeyboardIcon) => void;
  disabled?: boolean;
}) {
  const selectedCategory = customKeyboardIconOptions.find((option) => option.value === value)?.category ?? "terminal";
  const [activeCategory, setActiveCategory] = useState<CustomKeyboardIconCategory>(selectedCategory);
  const visibleOptions = customKeyboardIconOptions.filter((option) => option.category === activeCategory);

  useEffect(() => {
    setActiveCategory(selectedCategory);
  }, [selectedCategory]);

  return (
    <div className="mt-1.5">
      <div
        className="flex gap-1 overflow-x-auto rounded-[7px] border border-[#1d4325] bg-[#061008] p-0.5"
        role="tablist"
        aria-label="Icon categories"
      >
        {customKeyboardIconCategories.map((category) => (
          <button
            className={`min-w-0 flex-1 rounded-[5px] px-1.5 py-1.5 font-mono text-[0.48rem] font-bold uppercase tracking-[0.06em] disabled:cursor-not-allowed disabled:opacity-45 ${
              activeCategory === category.value ? "bg-[#194d25] text-[#d9ffdd]" : "text-[#6fa677] hover:text-[#b9f4bf]"
            }`}
            key={category.value}
            type="button"
            onClick={() => setActiveCategory(category.value)}
            disabled={disabled}
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
            className={`grid size-8 place-items-center rounded-[6px] border font-mono text-[0.62rem] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              value === option.value
                ? "border-[#8bff9a] bg-[#194d25] text-[#d9ffdd]"
                : "border-[#244d2d] bg-[#0a1c0e] text-[#80b888] hover:border-[#70c27b] hover:bg-[#102d17]"
            }`}
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled}
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

function CustomKeyboardProfileModal({
  mode,
  name,
  icon,
  isDefault,
  onNameChange,
  onIconChange,
  onClose,
  onSubmit,
  onDuplicate,
  onDelete,
}: {
  mode: "create" | "edit";
  name: string;
  icon: CustomKeyboardIcon;
  isDefault: boolean;
  onNameChange: (name: string) => void;
  onIconChange: (icon: CustomKeyboardIcon) => void;
  onClose: () => void;
  onSubmit: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  const canSubmit = isDefault || isCustomKeyboardProfileNameValid(name);

  return (
    <CustomKeyboardModalOverlay className="z-50 bg-[rgb(0_0_0_/_58%)] backdrop-blur-[2px]">
      <section
        className="my-auto flex max-h-full min-h-0 w-full max-w-[520px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[#2c6036] bg-[#071509] text-[#d9f4dc] shadow-[0_24px_80px_rgb(0_0_0_/_46%)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-keyboard-profile-modal-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-[#1d4325] px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <span className="font-mono text-[0.46rem] font-bold uppercase tracking-[0.14em] text-[#63ae6e]">
              Keyboard profiles
            </span>
            <h2 id="custom-keyboard-profile-modal-title" className="m-0 mt-0.5 text-[0.9rem] font-bold">
              {mode === "edit" ? "Edit profile" : "Add profile"}
            </h2>
          </div>
          <button
            className="grid size-8 place-items-center rounded-[7px] border border-[#315f3a] bg-[#0b2411] text-[#a9e8b1]"
            type="button"
            onClick={onClose}
            aria-label="Close profile dialog"
          >
            <AppIcon name="close" size={14} />
          </button>
        </header>
        <form
          id="custom-keyboard-profile-form"
          className="min-h-0 flex-1 overflow-y-auto p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) onSubmit();
          }}
        >
          <label className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-[0.5rem] font-bold uppercase tracking-[0.1em] text-[#6a9b72]">
              Profile name
            </span>
            <input
              className="min-h-10 min-w-0 rounded-[7px] border border-[#285a33] bg-[#061008] px-2.5 font-mono text-[0.68rem] text-[#d8ffdc] outline-none focus:border-[#8bff9a] disabled:opacity-45"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              maxLength={40}
              autoComplete="off"
              disabled={isDefault}
              aria-label="Profile name"
            />
          </label>
          <fieldset className="mt-3 border-0 p-0">
            <legend className="font-mono text-[0.5rem] font-bold uppercase tracking-[0.1em] text-[#6a9b72]">
              Profile icon
            </legend>
            <CustomKeyboardIconPicker value={icon} onChange={onIconChange} disabled={isDefault} />
          </fieldset>
        </form>
        <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-[#1d4325] px-3 py-2.5">
          {mode === "edit" && onDuplicate ? (
            <button
              className="rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-2.5 py-2 font-mono text-[0.52rem] font-bold uppercase tracking-[0.05em] text-[#9bd7a3]"
              type="button"
              onClick={onDuplicate}
            >
              Duplicate
            </button>
          ) : null}
          {mode === "edit" && onDelete ? (
            <button
              className="rounded-[7px] border border-[#5c302d] bg-[#24100f] px-2.5 py-2 font-mono text-[0.52rem] font-bold uppercase tracking-[0.05em] text-[#ffb0aa] disabled:cursor-not-allowed disabled:opacity-35"
              type="button"
              onClick={onDelete}
              disabled={isDefault}
            >
              Delete
            </button>
          ) : null}
          <span className="flex-1" />
          <button
            className="rounded-[7px] border border-[#315f3a] bg-[#0b2411] px-3 py-2 font-mono text-[0.56rem] font-bold uppercase tracking-[0.06em] text-[#9bd7a3]"
            type="button"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="rounded-[7px] bg-[#8bff9a] px-3 py-2 font-mono text-[0.56rem] font-bold uppercase tracking-[0.06em] text-[#061008] disabled:cursor-not-allowed disabled:opacity-35"
            type="submit"
            form="custom-keyboard-profile-form"
            disabled={!canSubmit}
          >
            {mode === "edit" ? (isDefault ? "Done" : "Save profile") : "Add profile"}
          </button>
        </footer>
      </section>
    </CustomKeyboardModalOverlay>
  );
}

function CustomKeyboardModalOverlay({ children, className }: { children: ReactNode; className: string }) {
  const viewport = useCustomKeyboardModalViewport();

  return (
    <div
      className={`custom-keyboard-modal-overlay fixed flex min-h-0 flex-col items-center overflow-y-auto overscroll-contain ${className}`}
      style={{
        top: `${viewport.top}px`,
        left: `${viewport.left}px`,
        width: `${viewport.width}px`,
        height: `${viewport.height}px`,
      }}
    >
      {children}
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
    <CustomKeyboardModalOverlay className="z-30 bg-[rgb(0_0_0_/_58%)] backdrop-blur-[2px]">
      <section
        className="my-auto flex max-h-full min-h-0 w-full max-w-[520px] shrink-0 flex-col overflow-hidden rounded-[14px] border border-[#2c6036] bg-[#071509] text-[#d9f4dc] shadow-[0_24px_80px_rgb(0_0_0_/_46%)]"
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
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
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
    </CustomKeyboardModalOverlay>
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
    case "paste":
      return (
        <svg {...iconProps}>
          <title>Paste</title>
          <rect x="5.5" y="5.5" width="13" height="15" rx="2" />
          <path d="M9 5.5V4h6v1.5M12 9v6m-3-3 3 3 3-3" />
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
    case "settings":
      return (
        <svg {...iconProps}>
          <title>Settings</title>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3.5" />
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

function compactTerminalActionLabel(button: CustomKeyboardKey): string | undefined {
  if (button.activation.type !== "terminal") return undefined;
  switch (button.activation.action) {
    case "paste-from-clipboard":
      return "clip";
    case "paste-from-tmux-buffer":
      return "tmux";
    default:
      return undefined;
  }
}

function shortcutDisplayLabel(button: CustomKeyboardKey): string {
  const sequenceLabel = keySequence(button)
    .map((token) => (token.type === "text" ? token.value : formatSequenceKeyLabel(token.key, token.modifiers ?? [])))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ");
  const compactLabel = Array.from(sequenceLabel).slice(0, 4).join("").trim();
  return compactLabel || "···";
}

function keySequence(button: CustomKeyboardKey): CustomKeyboardSequence {
  return button.activation.type === "sequence" ? button.activation.sequence : [];
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

function specialLibraryDisplayLabel(button: CustomKeyboardKey): string {
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
