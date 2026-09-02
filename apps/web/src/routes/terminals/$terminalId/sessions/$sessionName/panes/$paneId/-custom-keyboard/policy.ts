import { CUSTOM_KEYBOARD_EDITABLE_ROW_ID, customKeyboardFixedKeyIds } from "./definitions";
import type {
  CustomKeyboardDragSource,
  CustomKeyboardDropTarget,
  CustomKeyboardKey,
  CustomKeyboardLayout,
  CustomKeyboardLayoutPlacement,
  CustomKeyboardLayoutRow,
  CustomKeyboardModifier,
  CustomKeyboardResolvedLayoutRow,
  CustomKeyboardShortcutDraft,
} from "./viewmodel";

export function isCustomKeyboardShortcutDraftValid(draft: Pick<CustomKeyboardShortcutDraft, "sequence">): boolean {
  return draft.sequence.length > 0;
}

export function keysFromIds(keyIds: readonly string[], libraryKeys: readonly CustomKeyboardKey[]): CustomKeyboardKey[] {
  const keysById = new Map(libraryKeys.map((key) => [key.id, key] as const));
  return keyIds.flatMap((keyId) => {
    const key = keysById.get(keyId);
    return key ? [key] : [];
  });
}

export function resolveCustomKeyboardLayout(
  layout: CustomKeyboardLayout,
  libraryKeys: readonly CustomKeyboardKey[],
): CustomKeyboardResolvedLayoutRow[] {
  const keysById = new Map(libraryKeys.map((key) => [key.id, key] as const));
  return layout.rows.map((row) => ({
    id: row.id,
    overflow: row.overflow,
    items: row.placements.flatMap((placement) => {
      const key = keysById.get(placement.keyId);
      return key ? [{ ...placement, key }] : [];
    }),
  }));
}

export function assignedKeyIds(layout: CustomKeyboardLayout): string[] {
  return layout.rows
    .filter((row) => row.id === CUSTOM_KEYBOARD_EDITABLE_ROW_ID)
    .flatMap((row) => row.placements.map((placement) => placement.keyId));
}

export function toggleCustomKeyboardModifier(
  activeModifiers: readonly CustomKeyboardModifier[],
  modifier: CustomKeyboardModifier,
): CustomKeyboardModifier[] {
  return activeModifiers.includes(modifier)
    ? activeModifiers.filter((currentModifier) => currentModifier !== modifier)
    : [...activeModifiers, modifier];
}

export type CustomKeyboardDropState = {
  layout: CustomKeyboardLayout;
  shortcutKeyIds: readonly string[];
};

export function applyCustomKeyboardDrop(
  state: CustomKeyboardDropState,
  source: CustomKeyboardDragSource,
  target: CustomKeyboardDropTarget,
): CustomKeyboardDropState {
  if (target.type === "shortcut-library") {
    if (source.collection !== "shortcut-library") return copyDropState(state);
    return {
      layout: cloneLayout(state.layout),
      shortcutKeyIds: moveKeyId(state.shortcutKeyIds, source.keyId, target.targetIndex),
    };
  }

  if (source.collection === "shortcut-library") return copyDropState(state);
  if (target.rowId !== CUSTOM_KEYBOARD_EDITABLE_ROW_ID || customKeyboardFixedKeyIds.includes(source.keyId)) {
    return copyDropState(state);
  }
  const sourcePlacement = findPlacement(state.layout, source.keyId, source.rowId);
  if (
    source.collection === "keyboard" &&
    (!sourcePlacement || sourcePlacement.row.id !== CUSTOM_KEYBOARD_EDITABLE_ROW_ID)
  ) {
    return copyDropState(state);
  }
  if (!state.layout.rows.some((row) => row.id === target.rowId)) return copyDropState(state);

  const layout = removeKeyFromLayout(state.layout, source.keyId);
  const placement = sourcePlacement?.placement ?? { keyId: source.keyId, density: "regular" as const };
  return {
    layout: insertPlacementBeforeTarget(layout, target.rowId, placement, target.targetKeyId),
    shortcutKeyIds: [...state.shortcutKeyIds],
  };
}

export function removeKeyFromLayout(layout: CustomKeyboardLayout, keyId: string): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      placements:
        row.id === CUSTOM_KEYBOARD_EDITABLE_ROW_ID
          ? row.placements.filter((placement) => placement.keyId !== keyId)
          : [...row.placements],
    })),
  };
}

function insertPlacementBeforeTarget(
  layout: CustomKeyboardLayout,
  rowId: string,
  placement: CustomKeyboardLayoutPlacement,
  targetKeyId: string | null,
): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => {
      if (row.id !== rowId) return { ...row, placements: [...row.placements] };
      const placements = [...row.placements];
      const targetIndex =
        targetKeyId === null ? placements.length : placements.findIndex((item) => item.keyId === targetKeyId);
      placements.splice(targetIndex < 0 ? placements.length : targetIndex, 0, { ...placement });
      return { ...row, placements };
    }),
  };
}

function findPlacement(
  layout: CustomKeyboardLayout,
  keyId: string,
  rowId?: string,
): { row: CustomKeyboardLayoutRow; placement: CustomKeyboardLayoutPlacement } | null {
  const rows = rowId ? layout.rows.filter((row) => row.id === rowId) : layout.rows;
  for (const row of rows) {
    const placement = row.placements.find((candidate) => candidate.keyId === keyId);
    if (placement) return { row, placement };
  }
  return null;
}

function cloneLayout(layout: CustomKeyboardLayout): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      placements: row.placements.map((placement) => ({ ...placement })),
    })),
  };
}

function copyDropState(state: CustomKeyboardDropState): CustomKeyboardDropState {
  return {
    layout: cloneLayout(state.layout),
    shortcutKeyIds: [...state.shortcutKeyIds],
  };
}

function moveKeyId(keyIds: readonly string[], keyId: string, targetIndex: number): string[] {
  const next = [...keyIds];
  const sourceIndex = next.indexOf(keyId);
  if (sourceIndex < 0) return next;
  const [sourceKeyId] = next.splice(sourceIndex, 1);
  if (!sourceKeyId) return next;
  const insertionIndex = Math.max(0, Math.min(next.length, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex));
  next.splice(insertionIndex, 0, sourceKeyId);
  return next;
}
