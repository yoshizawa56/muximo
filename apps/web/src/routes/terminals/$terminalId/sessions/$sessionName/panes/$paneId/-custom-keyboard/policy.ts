import type {
  CustomKeyboardButton,
  CustomKeyboardDragSource,
  CustomKeyboardDropTarget,
  CustomKeyboardModifier,
  CustomKeyboardShortcutDraft,
} from "./viewmodel";

export function isCustomKeyboardShortcutDraftValid(draft: Pick<CustomKeyboardShortcutDraft, "sequence">): boolean {
  return draft.sequence.length > 0;
}

export function selectedButtonsFromIds(
  selectedButtonIds: readonly string[],
  libraryButtons: readonly CustomKeyboardButton[],
): CustomKeyboardButton[] {
  const buttonsById = new Map(libraryButtons.map((button) => [button.id, button] as const));
  return selectedButtonIds.flatMap((buttonId) => {
    const button = buttonsById.get(buttonId);
    return button ? [button] : [];
  });
}

export function toggleCustomKeyboardModifier(
  activeModifiers: readonly CustomKeyboardModifier[],
  modifier: CustomKeyboardModifier,
): CustomKeyboardModifier[] {
  return activeModifiers.includes(modifier)
    ? activeModifiers.filter((currentModifier) => currentModifier !== modifier)
    : [...activeModifiers, modifier];
}

export function insertButtonIdBeforeTarget(
  buttonIds: readonly string[],
  sourceId: string,
  targetId: string | null,
): string[] {
  const sourceIndex = buttonIds.indexOf(sourceId);
  const targetIndex = targetId === null ? -1 : buttonIds.indexOf(targetId);

  if (sourceIndex >= 0) {
    if (targetId === null || targetIndex < 0 || sourceIndex === targetIndex) return [...buttonIds];
    const next = [...buttonIds];
    next.splice(sourceIndex, 1);
    const nextTargetIndex = next.indexOf(targetId);
    next.splice(nextTargetIndex, 0, sourceId);
    return next;
  }

  const next = [...buttonIds];
  next.splice(targetIndex < 0 ? next.length : targetIndex, 0, sourceId);
  return next;
}

export type CustomKeyboardDropState = {
  selectedButtonIds: readonly string[];
  shortcutButtonIds: readonly string[];
};

export function applyCustomKeyboardDrop(
  state: CustomKeyboardDropState,
  source: CustomKeyboardDragSource,
  target: CustomKeyboardDropTarget,
): CustomKeyboardDropState {
  if (target.type === "shortcut-library") {
    if (source.collection !== "shortcut-library") return copyDropState(state);
    return {
      selectedButtonIds: [...state.selectedButtonIds],
      shortcutButtonIds: moveButtonId(state.shortcutButtonIds, source.buttonId, target.targetIndex),
    };
  }

  if (source.collection === "shortcut-library") return copyDropState(state);

  if (source.collection === "keyboard" && !state.selectedButtonIds.includes(source.buttonId)) {
    return copyDropState(state);
  }

  return {
    selectedButtonIds: insertButtonIdBeforeTarget(state.selectedButtonIds, source.buttonId, target.targetButtonId),
    shortcutButtonIds: [...state.shortcutButtonIds],
  };
}

function copyDropState(state: CustomKeyboardDropState): CustomKeyboardDropState {
  return {
    selectedButtonIds: [...state.selectedButtonIds],
    shortcutButtonIds: [...state.shortcutButtonIds],
  };
}

function moveButtonId(buttonIds: readonly string[], buttonId: string, targetIndex: number): string[] {
  const next = [...buttonIds];
  const sourceIndex = next.indexOf(buttonId);
  if (sourceIndex < 0) return next;
  const [sourceButtonId] = next.splice(sourceIndex, 1);
  if (!sourceButtonId) return next;
  const insertionIndex = Math.max(0, Math.min(next.length, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex));
  next.splice(insertionIndex, 0, sourceButtonId);
  return next;
}
