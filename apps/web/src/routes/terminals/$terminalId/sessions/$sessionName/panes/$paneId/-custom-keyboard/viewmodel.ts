import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CUSTOM_KEYBOARD_EDITABLE_ROW_ID,
  customKeyboardFixedKeyIds,
  customKeyboardKeyLibrary,
  customKeyboardSurfaceDefinitions,
  defaultCustomKeyboardFixedLayout,
  defaultCustomKeyboardLayout,
} from "./definitions";
import { type CustomKeyboardIcon, customKeyboardIconOptions } from "./icons";
import {
  applyCustomKeyboardDrop,
  assignedKeyIds,
  isCustomKeyboardShortcutDraftValid,
  keysFromIds,
  removeKeyFromLayout,
  resolveCustomKeyboardLayout,
  toggleCustomKeyboardModifier,
} from "./policy";
import { type CustomKeyboardStorage, createCustomKeyboardStorage } from "./storage";
import type { CustomKeyboardTerminalAction } from "./terminal-actions";
import { isCustomKeyboardTerminalAction } from "./terminal-actions";

export type {
  CustomKeyboardDefaultPlacement,
  CustomKeyboardKeyDefinition,
  CustomKeyboardSpecialKeyDefinition,
  CustomKeyboardSpecialModifierDefinition,
  CustomKeyboardTerminalActionDefinition,
} from "./definitions";
export {
  CUSTOM_KEYBOARD_EDITABLE_ROW_ID,
  CUSTOM_KEYBOARD_FIXED_ROW_ID,
  customKeyboardFixedKeyIds,
  customKeyboardKeyDefinitions,
  customKeyboardKeyLibrary,
  customKeyboardSpecialKeyOptions,
  customKeyboardSpecialModifierOptions,
  customKeyboardSurfaceDefinitions,
  customKeyboardTerminalActionOptions,
  defaultCustomKeyboardFixedKeys,
  defaultCustomKeyboardFixedLayout,
  defaultCustomKeyboardKeys,
  defaultCustomKeyboardLayout,
  defineKey,
} from "./definitions";
export type {
  CustomKeyboardIcon,
  CustomKeyboardIconCategory,
} from "./icons";
export { customKeyboardIconCategories, customKeyboardIconOptions } from "./icons";
export { CUSTOM_KEYBOARD_STORAGE_KEY } from "./storage";
export type { CustomKeyboardTerminalAction } from "./terminal-actions";

export type CustomKeyboardModifier = "ctrl" | "alt" | "shift";

export type CustomKeyboardSequenceToken =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "key";
      key: string;
      modifiers?: readonly CustomKeyboardModifier[];
    };

export type CustomKeyboardSequence = readonly CustomKeyboardSequenceToken[];

export type CustomKeyboardNativeAction = "pick-photo" | "capture-photo" | "scan-qr" | "toggle-standard-keyboard";

export type CustomKeyboardNativeFileAction = Extract<CustomKeyboardNativeAction, "pick-photo" | "capture-photo">;

export type CustomKeyboardKeyCategory = "abc" | "123" | "special" | "shortcuts";

export type CustomKeyboardKeyActivation =
  | {
      type: "sequence";
      sequence: CustomKeyboardSequence;
    }
  | {
      type: "modifier";
      modifier: CustomKeyboardModifier;
    }
  | {
      type: "native";
      action: CustomKeyboardNativeAction;
    }
  | {
      type: "terminal";
      action: CustomKeyboardTerminalAction;
    }
  | {
      type: "directional-flick";
    }
  | {
      type: "surface";
      surface: CustomKeyboardSurfaceId;
    };

export type CustomKeyboardSurfaceId = "clipboard" | "profile";

export type CustomKeyboardKey = {
  id: string;
  category: CustomKeyboardKeyCategory;
  icon?: CustomKeyboardIcon;
  label?: string;
  accessibleLabel: string;
  activation: CustomKeyboardKeyActivation;
};

export type CustomKeyboardLayoutPlacement = {
  keyId: string;
  density: "regular" | "compact";
  flexGrow?: number;
};

export type CustomKeyboardLayoutRow = {
  id: string;
  overflow: "scroll" | "stable";
  placements: CustomKeyboardLayoutPlacement[];
};

export type CustomKeyboardLayout = {
  rows: CustomKeyboardLayoutRow[];
};

export type CustomKeyboardResolvedLayoutItem = CustomKeyboardLayoutPlacement & {
  key: CustomKeyboardKey;
};

export type CustomKeyboardResolvedLayoutRow = Omit<CustomKeyboardLayoutRow, "placements"> & {
  items: CustomKeyboardResolvedLayoutItem[];
};

export type CustomKeyboardProfile = {
  id: string;
  name: string;
  icon: CustomKeyboardIcon;
  layout: CustomKeyboardLayout;
  libraryKeys: CustomKeyboardKey[];
  shortcutKeyIds: string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
};

export type CustomKeyboardSurfaceViewModel = {
  id: CustomKeyboardSurfaceId;
  keys: readonly CustomKeyboardKey[];
};

export type CustomKeyboardProfileSummary = {
  id: string;
  name: string;
  icon: CustomKeyboardIcon;
  linked: boolean;
};

export type CustomKeyboardDragCollection = "keyboard" | "library" | "shortcut-library";

export type CustomKeyboardDragSource = {
  keyId: string;
  collection: CustomKeyboardDragCollection;
  rowId?: string;
};

export type CustomKeyboardDropTarget =
  | {
      type: "keyboard";
      rowId: string;
      targetKeyId: string | null;
    }
  | {
      type: "shortcut-library";
      targetIndex: number;
    };

export type CustomKeyboardShortcutDraft = {
  icon: CustomKeyboardIcon;
  sequence: CustomKeyboardSequence;
};

export type CustomKeyboardFlickDirection = "up" | "down" | "left" | "right";

export type CustomKeyboardViewModel = {
  rows: readonly CustomKeyboardResolvedLayoutRow[];
  surfaces: readonly CustomKeyboardSurfaceViewModel[];
  activeModifiers: readonly CustomKeyboardModifier[];
  nativeKeyboardVisible: boolean;
  activeProfile: CustomKeyboardProfileSummary;
  profiles: readonly CustomKeyboardProfileSummary[];
  workspaceId: string | null;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onSelectProfile: (profileId: string) => void;
  onActivateKey: (key: CustomKeyboardKey) => void;
  onDirectionalFlick: (direction: CustomKeyboardFlickDirection) => void;
  onNativeFileSelected: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onKeepNativeKeyboardOpen: () => void;
  onToggleNativeKeyboard: () => void;
};

export type CustomKeyboardSettingsViewModel = {
  rows: readonly CustomKeyboardResolvedLayoutRow[];
  availableKeys: readonly CustomKeyboardKey[];
  shortcutKeys: readonly CustomKeyboardKey[];
  activeProfile: CustomKeyboardProfileSummary;
  profiles: readonly CustomKeyboardProfileSummary[];
  linkedProfileIds: readonly string[];
  workspaceId: string | null;
  assignedKeyIds: readonly string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (input: { name: string; icon: CustomKeyboardIcon }) => void;
  onDuplicateProfile: (profileId: string) => void;
  onRenameProfile: (profileId: string, name: string) => void;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileIcon: (profileId: string, icon: CustomKeyboardIcon) => void;
  onToggleProfileLink: (profileId: string) => void;
  onDrop: (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => void;
  onRemoveKey: (keyId: string) => void;
  onRegisterShortcut: (draft: CustomKeyboardShortcutDraft) => void;
  onUpdateShortcut: (keyId: string, draft: CustomKeyboardShortcutDraft) => void;
  onDeleteShortcut: (keyId: string) => void;
  onRepeatStartDelayChange: (startDelayMs: number) => void;
  onRepeatIntervalChange: (intervalMs: number) => void;
};

export type CustomKeyboardControllerOptions = {
  workspaceId: string | null;
  nativeKeyboardVisible: boolean;
  activeModifiers?: readonly CustomKeyboardModifier[];
  onActiveModifiersChange?: (modifiers: readonly CustomKeyboardModifier[]) => void;
  onSequence: (sequence: CustomKeyboardSequence, activeModifiers: readonly CustomKeyboardModifier[]) => void;
  onKeyEffect?: () => void;
  onNativeAction?: (action: CustomKeyboardNativeAction) => void;
  onTerminalAction: (action: CustomKeyboardTerminalAction) => void;
  onNativeFileSelected?: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onKeepNativeKeyboardOpen?: () => void;
  onNativeKeyboardToggle: () => void;
};

export type CustomKeyboardController = {
  keyboard: CustomKeyboardViewModel;
  settings: CustomKeyboardSettingsViewModel;
};

export const DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID = "default";

const CUSTOM_KEYBOARD_STATE_VERSION = 2;
type CustomKeyboardStateVersion = 1 | typeof CUSTOM_KEYBOARD_STATE_VERSION;

type StoredCustomKeyboardState = {
  version?: unknown;
  profiles?: unknown;
  workspaceProfileIds?: unknown;
  activeProfileIdsByWorkspace?: unknown;
  globalActiveProfileId?: unknown;
};

export type CustomKeyboardState = {
  version: typeof CUSTOM_KEYBOARD_STATE_VERSION;
  profiles: CustomKeyboardProfile[];
  workspaceProfileIds: Record<string, string[]>;
  activeProfileIdsByWorkspace: Record<string, string>;
  globalActiveProfileId: string;
};

const CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH = 40;

export function useCustomKeyboardViewModel(options: CustomKeyboardControllerOptions): CustomKeyboardController {
  const [state, setState] = useState<CustomKeyboardState>(() => createDefaultCustomKeyboardState());
  const [storage] = useState<CustomKeyboardStorage>(() => createCustomKeyboardStorage());
  const [isHydrated, setIsHydrated] = useState(false);
  const [localActiveModifiers, setLocalActiveModifiers] = useState<CustomKeyboardModifier[]>([]);
  const activeModifiers = options.activeModifiers ?? localActiveModifiers;
  const activeModifiersRef = useRef<CustomKeyboardModifier[]>([...activeModifiers]);

  const activeProfileId = useMemo(
    () => resolveActiveProfileId(state, options.workspaceId),
    [options.workspaceId, state],
  );
  const activeProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === activeProfileId) ?? createDefaultCustomKeyboardProfile(),
    [activeProfileId, state.profiles],
  );
  const linkedProfileIds = useMemo(
    () => (options.workspaceId ? (state.workspaceProfileIds[options.workspaceId] ?? []) : []),
    [options.workspaceId, state.workspaceProfileIds],
  );
  const profileSummaries = useMemo(
    () =>
      state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        icon: profile.icon,
        linked: options.workspaceId
          ? profile.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || linkedProfileIds.includes(profile.id)
          : true,
      })),
    [linkedProfileIds, options.workspaceId, state.profiles],
  );
  const activeProfileSummary = useMemo(
    () =>
      profileSummaries.find((profile) => profile.id === activeProfileId) ?? {
        id: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
        name: "Default",
        icon: "terminal" as const,
        linked: true,
      },
    [activeProfileId, profileSummaries],
  );

  useLayoutEffect(() => {
    activeModifiersRef.current = [...activeModifiers];
  }, [activeModifiers]);

  const updateActiveModifiers = useCallback(
    (nextModifiers: readonly CustomKeyboardModifier[]) => {
      const next = [...nextModifiers];
      activeModifiersRef.current = next;
      setLocalActiveModifiers(next);
      options.onActiveModifiersChange?.(next);
    },
    [options.onActiveModifiersChange],
  );

  useEffect(() => {
    let disposed = false;
    void storage
      .read()
      .then((raw) => {
        if (disposed) return;
        setState(parseCustomKeyboardState(raw));
        setIsHydrated(true);
      })
      .catch(() => {
        if (!disposed) setIsHydrated(true);
      });
    return () => {
      disposed = true;
    };
  }, [storage]);

  useEffect(() => {
    if (!isHydrated) return;
    void storage.write(JSON.stringify(state));
  }, [isHydrated, state, storage]);

  const onSelectProfile = useCallback(
    (profileId: string) => {
      setState((current) => selectCustomKeyboardProfile(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onCreateProfile = useCallback(
    (input: { name: string; icon: CustomKeyboardIcon }) => {
      setState((current) => createCustomKeyboardProfile(current, options.workspaceId, input));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onDuplicateProfile = useCallback(
    (profileId: string) => {
      setState((current) => duplicateCustomKeyboardProfile(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onRenameProfile = useCallback((profileId: string, name: string) => {
    if (!isCustomKeyboardProfileNameValid(name)) return;
    setState((current) =>
      updateCustomKeyboardProfile(current, profileId, (profile) => ({ ...profile, name: name.trim() })),
    );
  }, []);

  const onDeleteProfile = useCallback(
    (profileId: string) => {
      setState((current) => deleteCustomKeyboardProfile(current, profileId));
      updateActiveModifiers([]);
    },
    [updateActiveModifiers],
  );

  const onSetProfileIcon = useCallback((profileId: string, icon: CustomKeyboardIcon) => {
    setState((current) => updateCustomKeyboardProfile(current, profileId, (profile) => ({ ...profile, icon })));
  }, []);

  const onToggleProfileLink = useCallback(
    (profileId: string) => {
      setState((current) => toggleCustomKeyboardProfileLink(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onToggleNativeKeyboard = useCallback(() => {
    options.onNativeKeyboardToggle();
  }, [options.onNativeKeyboardToggle]);

  const onActivateKey = useCallback(
    (key: CustomKeyboardKey) => {
      const activation = key.activation;
      switch (activation.type) {
        case "surface":
        case "directional-flick":
          return;
        case "modifier":
          updateActiveModifiers(toggleCustomKeyboardModifier(activeModifiersRef.current, activation.modifier));
          return;
        case "sequence": {
          const modifiers = activeModifiersRef.current;
          updateActiveModifiers([]);
          options.onSequence(activation.sequence, modifiers);
          return;
        }
        case "native":
          updateActiveModifiers([]);
          if (activation.action === "toggle-standard-keyboard") onToggleNativeKeyboard();
          options.onNativeAction?.(activation.action);
          return;
        case "terminal":
          updateActiveModifiers([]);
          options.onTerminalAction(activation.action);
          return;
        default:
          return assertNeverCustomKeyboardActivation(activation);
      }
    },
    [
      onToggleNativeKeyboard,
      options.onNativeAction,
      options.onSequence,
      options.onTerminalAction,
      updateActiveModifiers,
    ],
  );

  const onDirectionalFlick = useCallback(
    (direction: CustomKeyboardFlickDirection) => {
      updateActiveModifiers([]);
      options.onSequence([{ type: "key", key: directionalFlickKey(direction) }], []);
      options.onKeyEffect?.();
    },
    [options.onKeyEffect, options.onSequence, updateActiveModifiers],
  );

  const onKeepNativeKeyboardOpen = useCallback(() => {
    options.onKeepNativeKeyboardOpen?.();
  }, [options.onKeepNativeKeyboardOpen]);

  const onDrop = useCallback(
    (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => {
      setState((current) => {
        const currentProfile = current.profiles.find(
          (profile) => profile.id === resolveActiveProfileId(current, options.workspaceId),
        );
        if (!currentProfile) return current;
        const sourceKey = currentProfile.libraryKeys.find((key) => key.id === source.keyId);
        if (!sourceKey) return current;
        if (source.collection === "shortcut-library" && sourceKey.category !== "shortcuts") return current;
        return updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => {
          const next = applyCustomKeyboardDrop(
            { layout: profile.layout, shortcutKeyIds: profile.shortcutKeyIds },
            source,
            target,
          );
          return {
            ...profile,
            layout: next.layout,
            shortcutKeyIds: [...next.shortcutKeyIds],
          };
        });
      });
    },
    [options.workspaceId],
  );

  const onRemoveKey = useCallback(
    (keyId: string) => {
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          layout: removeKeyFromLayout(profile.layout, keyId),
        })),
      );
    },
    [options.workspaceId],
  );

  const onRegisterShortcut = useCallback(
    (draft: CustomKeyboardShortcutDraft) => {
      if (!isCustomKeyboardShortcutDraftValid(draft)) return;
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => {
          const id = nextShortcutId(profile.libraryKeys);
          const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
          const shortcut: CustomKeyboardKey = {
            id,
            category: "shortcuts",
            icon: draft.icon,
            accessibleLabel: `${iconLabel} shortcut`,
            activation: { type: "sequence", sequence: draft.sequence },
          };
          return {
            ...profile,
            libraryKeys: [...profile.libraryKeys, shortcut],
            shortcutKeyIds: [...profile.shortcutKeyIds, shortcut.id],
          };
        }),
      );
    },
    [options.workspaceId],
  );

  const onUpdateShortcut = useCallback(
    (keyId: string, draft: CustomKeyboardShortcutDraft) => {
      if (customKeyboardFixedKeyIds.includes(keyId)) return;
      if (!isCustomKeyboardShortcutDraftValid(draft)) return;
      const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
      const update = (key: CustomKeyboardKey): CustomKeyboardKey =>
        key.id === keyId
          ? {
              ...key,
              icon: draft.icon,
              accessibleLabel: `${iconLabel} shortcut`,
              activation: { type: "sequence", sequence: draft.sequence },
            }
          : key;
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          libraryKeys: profile.libraryKeys.map(update),
        })),
      );
    },
    [options.workspaceId],
  );

  const onDeleteShortcut = useCallback(
    (keyId: string) => {
      if (customKeyboardFixedKeyIds.includes(keyId)) return;
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          layout: removeKeyFromLayout(profile.layout, keyId),
          libraryKeys: profile.libraryKeys.filter((key) => key.id !== keyId),
          shortcutKeyIds: profile.shortcutKeyIds.filter((id) => id !== keyId),
        })),
      );
    },
    [options.workspaceId],
  );

  const editableRows = useMemo(
    () => resolveCustomKeyboardLayout(activeProfile.layout, activeProfile.libraryKeys),
    [activeProfile],
  );
  const fixedRows = useMemo(
    () => resolveCustomKeyboardLayout(defaultCustomKeyboardFixedLayout, customKeyboardKeyLibrary),
    [],
  );
  const rows = useMemo(() => [...editableRows, ...fixedRows], [editableRows, fixedRows]);
  const surfaces = useMemo(
    () =>
      customKeyboardSurfaceDefinitions.map((surface) => ({
        id: surface.id,
        keys: keysFromIds(surface.keyIds, activeProfile.libraryKeys),
      })),
    [activeProfile.libraryKeys],
  );
  const shortcutKeys = useMemo(
    () => keysFromIds(activeProfile.shortcutKeyIds, activeProfile.libraryKeys),
    [activeProfile],
  );
  const assignedIds = useMemo(() => assignedKeyIds(activeProfile.layout), [activeProfile.layout]);
  const availableKeys = useMemo(() => {
    const assigned = new Set(assignedIds);
    return activeProfile.libraryKeys.filter(
      (candidate) => !assigned.has(candidate.id) && !customKeyboardFixedKeyIds.includes(candidate.id),
    );
  }, [activeProfile.libraryKeys, assignedIds]);

  const keyboard: CustomKeyboardViewModel = {
    rows,
    surfaces,
    activeModifiers,
    nativeKeyboardVisible: options.nativeKeyboardVisible,
    activeProfile: activeProfileSummary,
    profiles: profileSummaries,
    workspaceId: options.workspaceId,
    repeatStartDelayMs: activeProfile.repeatStartDelayMs,
    repeatIntervalMs: activeProfile.repeatIntervalMs,
    onSelectProfile,
    onActivateKey,
    onDirectionalFlick,
    onNativeFileSelected: (action, file) => options.onNativeFileSelected?.(action, file),
    onKeepNativeKeyboardOpen,
    onToggleNativeKeyboard,
  };

  const settings: CustomKeyboardSettingsViewModel = {
    rows: editableRows,
    availableKeys,
    shortcutKeys,
    activeProfile: activeProfileSummary,
    profiles: profileSummaries,
    linkedProfileIds,
    workspaceId: options.workspaceId,
    assignedKeyIds: assignedIds,
    repeatStartDelayMs: activeProfile.repeatStartDelayMs,
    repeatIntervalMs: activeProfile.repeatIntervalMs,
    onSelectProfile,
    onCreateProfile,
    onDuplicateProfile,
    onRenameProfile,
    onDeleteProfile,
    onSetProfileIcon,
    onToggleProfileLink,
    onDrop,
    onRemoveKey,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (repeatStartDelayMs) =>
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          repeatStartDelayMs,
        })),
      ),
    onRepeatIntervalChange: (repeatIntervalMs) =>
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          repeatIntervalMs,
        })),
      ),
  };

  return {
    keyboard,
    settings,
  };
}

function directionalFlickKey(direction: CustomKeyboardFlickDirection): string {
  return {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  }[direction];
}

function assertNeverCustomKeyboardActivation(value: never): never {
  throw new Error(`Unsupported custom keyboard activation: ${String(value)}`);
}

function mergeUniqueKeys(keys: readonly CustomKeyboardKey[]): CustomKeyboardKey[] {
  return [...new Map(keys.map((key) => [key.id, key] as const)).values()];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function nextShortcutId(keys: readonly CustomKeyboardKey[]): string {
  const existingIds = new Set(keys.map((key) => key.id));
  let index = keys.length + 1;
  while (existingIds.has(`custom-shortcut-${index}`)) index += 1;
  return `custom-shortcut-${index}`;
}

function nextProfileId(profiles: readonly CustomKeyboardProfile[]): string {
  const existingIds = new Set(profiles.map((profile) => profile.id));
  let index = profiles.length + 1;
  while (existingIds.has(`custom-keyboard-profile-${index}`)) index += 1;
  return `custom-keyboard-profile-${index}`;
}

export function isCustomKeyboardProfileNameValid(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 && trimmed.length <= CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH && !/[\u0000\r\n\t]/.test(name)
  );
}

function createDefaultCustomKeyboardState(): CustomKeyboardState {
  return {
    version: CUSTOM_KEYBOARD_STATE_VERSION,
    profiles: [createDefaultCustomKeyboardProfile()],
    workspaceProfileIds: {},
    activeProfileIdsByWorkspace: {},
    globalActiveProfileId: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
  };
}

function createDefaultCustomKeyboardProfile(): CustomKeyboardProfile {
  return {
    id: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
    name: "Default",
    icon: "terminal",
    layout: cloneCustomKeyboardLayout(defaultCustomKeyboardLayout),
    libraryKeys: [...customKeyboardKeyLibrary],
    shortcutKeyIds: customKeyboardKeyLibrary.filter((key) => key.category === "shortcuts").map((key) => key.id),
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
  };
}

export function parseCustomKeyboardState(raw: string | null): CustomKeyboardState {
  const fallback = createDefaultCustomKeyboardState();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return fallback;
    const version = parsed.version === undefined ? 1 : parsed.version === CUSTOM_KEYBOARD_STATE_VERSION ? 2 : null;
    if (version === null) return fallback;
    return parseStoredCustomKeyboardState(parsed, fallback, version);
  } catch {
    return fallback;
  }
}

function parseStoredCustomKeyboardState(
  parsed: StoredCustomKeyboardState,
  fallback: CustomKeyboardState,
  version: CustomKeyboardStateVersion,
): CustomKeyboardState {
  if (
    !Array.isArray(parsed.profiles) ||
    !isRecord(parsed.workspaceProfileIds) ||
    !isRecord(parsed.activeProfileIdsByWorkspace) ||
    typeof parsed.globalActiveProfileId !== "string"
  ) {
    return fallback;
  }
  const profiles = normalizeProfiles(parsed.profiles, version);
  if (profiles.length === 0) return fallback;
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const workspaceProfileIds = normalizeWorkspaceProfileIds(parsed.workspaceProfileIds, profileIds);
  const activeProfileIdsByWorkspace = normalizeActiveProfileIdsByWorkspace(
    parsed.activeProfileIdsByWorkspace,
    profileIds,
  );
  const globalActiveProfileId =
    typeof parsed.globalActiveProfileId === "string" && profileIds.has(parsed.globalActiveProfileId)
      ? parsed.globalActiveProfileId
      : DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  return {
    version: CUSTOM_KEYBOARD_STATE_VERSION,
    profiles,
    workspaceProfileIds,
    activeProfileIdsByWorkspace,
    globalActiveProfileId,
  };
}

function normalizeProfiles(value: unknown, version: CustomKeyboardStateVersion): CustomKeyboardProfile[] {
  if (!Array.isArray(value)) return [createDefaultCustomKeyboardProfile()];
  const parsedProfiles = value.flatMap((candidate) => {
    const profile = normalizeProfile(candidate, version);
    return profile ? [profile] : [];
  });
  const uniqueProfileMap = new Map<string, CustomKeyboardProfile>();
  for (const profile of parsedProfiles) {
    if (!uniqueProfileMap.has(profile.id)) uniqueProfileMap.set(profile.id, profile);
  }
  const defaultProfile =
    uniqueProfileMap.get(DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID) ?? createDefaultCustomKeyboardProfile();
  return [defaultProfile, ...[...uniqueProfileMap.values()].filter((profile) => profile.id !== defaultProfile.id)];
}

function normalizeProfile(value: unknown, version: CustomKeyboardStateVersion): CustomKeyboardProfile | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.name !== "string" ||
    !isCustomKeyboardIcon(value.icon) ||
    !Array.isArray(value.libraryKeys) ||
    !isRecord(value.layout) ||
    !Array.isArray(value.shortcutKeyIds) ||
    typeof value.repeatStartDelayMs !== "number" ||
    typeof value.repeatIntervalMs !== "number"
  ) {
    return null;
  }
  const isDefault = value.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  const name = isDefault ? "Default" : value.name.trim();
  if (!isDefault && !isCustomKeyboardProfileNameValid(name)) return null;
  const icon = isDefault ? "terminal" : (validProfileIcon(value.icon) ?? "terminal");
  const storedLibraryKeys = validKeyArray(value.libraryKeys) ?? [];
  const builtInKeyIds = new Set(customKeyboardKeyLibrary.map((key) => key.id));
  const libraryKeys = mergeUniqueKeys([
    ...customKeyboardKeyLibrary,
    ...storedLibraryKeys.filter((key) => !builtInKeyIds.has(key.id) && isUserDefinedCustomKeyboardKey(key)),
  ]);
  const layout =
    version === 1
      ? migrateLegacyCustomKeyboardLayout(value.layout, libraryKeys)
      : normalizeCustomKeyboardLayout(value.layout, libraryKeys);
  const defaultShortcutKeyIds = libraryKeys.filter((key) => key.category === "shortcuts").map((key) => key.id);
  const shortcutKeyIds = uniqueIds(
    (validStringArray(value.shortcutKeyIds) ?? defaultShortcutKeyIds).filter((keyId) =>
      libraryKeys.some((key) => key.id === keyId && key.category === "shortcuts"),
    ),
  );
  return {
    id: value.id,
    name: isDefault ? "Default" : name,
    icon,
    layout,
    libraryKeys,
    shortcutKeyIds,
    repeatStartDelayMs: validNumber(value.repeatStartDelayMs, 200, 1200, 420),
    repeatIntervalMs: validNumber(value.repeatIntervalMs, 80, 600, 180),
  };
}

function migrateLegacyCustomKeyboardLayout(
  value: unknown,
  libraryKeys: readonly CustomKeyboardKey[],
): CustomKeyboardLayout {
  // Version 1 stored the fixed utility row inside every profile. The row is now global and must not be migrated into
  // the editable profile layout.
  return normalizeCustomKeyboardLayout(value, libraryKeys);
}

function normalizeCustomKeyboardLayout(
  value: unknown,
  libraryKeys: readonly CustomKeyboardKey[],
): CustomKeyboardLayout {
  if (!isRecord(value) || !Array.isArray(value.rows)) return cloneCustomKeyboardLayout(defaultCustomKeyboardLayout);
  const libraryKeyIds = new Set(libraryKeys.map((key) => key.id));
  const usedKeyIds = new Set<string>();
  const usedRowIds = new Set<string>();
  const rows: CustomKeyboardLayoutRow[] = value.rows.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.trim().length === 0) return [];
    if (candidate.id !== CUSTOM_KEYBOARD_EDITABLE_ROW_ID) return [];
    if (usedRowIds.has(candidate.id) || !Array.isArray(candidate.placements)) return [];
    const overflow = candidate.overflow === "stable" || candidate.overflow === "scroll" ? candidate.overflow : null;
    if (!overflow) return [];
    usedRowIds.add(candidate.id);
    const placements: CustomKeyboardLayoutPlacement[] = candidate.placements.flatMap((placement) => {
      if (!isRecord(placement) || typeof placement.keyId !== "string" || !libraryKeyIds.has(placement.keyId)) {
        return [];
      }
      if (customKeyboardFixedKeyIds.includes(placement.keyId)) return [];
      if (usedKeyIds.has(placement.keyId)) return [];
      const density = placement.density === "compact" || placement.density === "regular" ? placement.density : null;
      if (!density) return [];
      const flexGrow = validFlexGrow(placement.flexGrow);
      usedKeyIds.add(placement.keyId);
      return [
        {
          keyId: placement.keyId,
          density: density as "compact" | "regular",
          ...(flexGrow === undefined ? {} : { flexGrow }),
        },
      ];
    });
    return [{ id: candidate.id, overflow: overflow as "scroll" | "stable", placements }];
  });
  return rows.length > 0 ? { rows } : cloneCustomKeyboardLayout(defaultCustomKeyboardLayout);
}

function cloneCustomKeyboardLayout(layout: CustomKeyboardLayout): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      placements: row.placements.map((placement) => ({ ...placement })),
    })),
  };
}

function cloneCustomKeyboardKey(key: CustomKeyboardKey): CustomKeyboardKey {
  const activation = key.activation;
  return {
    ...key,
    activation:
      activation.type === "sequence"
        ? { type: "sequence", sequence: activation.sequence.map(cloneCustomKeyboardSequenceToken) }
        : { ...activation },
  };
}

const CUSTOM_KEYBOARD_MAX_FLEX_GROW = 8;

function cloneCustomKeyboardSequenceToken(token: CustomKeyboardSequenceToken): CustomKeyboardSequenceToken {
  return token.type === "text"
    ? { ...token }
    : {
        ...token,
        ...(token.modifiers === undefined ? {} : { modifiers: [...token.modifiers] }),
      };
}

function validFlexGrow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(CUSTOM_KEYBOARD_MAX_FLEX_GROW, value)
    : undefined;
}

function normalizeWorkspaceProfileIds(value: unknown, profileIds: ReadonlySet<string>): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([workspaceId, profileIdsValue]) => {
      if (!workspaceId || !Array.isArray(profileIdsValue)) return [];
      const ids = uniqueIds(
        profileIdsValue.filter(
          (profileId): profileId is string =>
            typeof profileId === "string" &&
            profileId !== DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID &&
            profileIds.has(profileId),
        ),
      );
      return ids.length > 0 ? [[workspaceId, ids]] : [];
    }),
  );
}

function normalizeActiveProfileIdsByWorkspace(value: unknown, profileIds: ReadonlySet<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([workspaceId, profileId]) =>
      workspaceId && typeof profileId === "string" && profileIds.has(profileId) ? [[workspaceId, profileId]] : [],
    ),
  );
}

export function resolveActiveProfileId(state: CustomKeyboardState, workspaceId: string | null): string {
  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  if (!workspaceId)
    return profileIds.has(state.globalActiveProfileId)
      ? state.globalActiveProfileId
      : DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  const mappedProfileId = state.activeProfileIdsByWorkspace[workspaceId];
  if (
    mappedProfileId &&
    profileIds.has(mappedProfileId) &&
    (mappedProfileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || linkedProfileIds.includes(mappedProfileId))
  ) {
    return mappedProfileId;
  }
  return linkedProfileIds.find((profileId) => profileIds.has(profileId)) ?? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
}

function updateActiveCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  update: (profile: CustomKeyboardProfile) => CustomKeyboardProfile,
): CustomKeyboardState {
  const activeProfileId = resolveActiveProfileId(state, workspaceId);
  return {
    ...state,
    profiles: state.profiles.map((profile) => (profile.id === activeProfileId ? update(profile) : profile)),
  };
}

function updateCustomKeyboardProfile(
  state: CustomKeyboardState,
  profileId: string,
  update: (profile: CustomKeyboardProfile) => CustomKeyboardProfile,
): CustomKeyboardState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  return {
    ...state,
    profiles: state.profiles.map((profile) => (profile.id === profileId ? update(profile) : profile)),
  };
}

export function selectCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  if (!workspaceId) return { ...state, globalActiveProfileId: profileId };
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  const nextLinkedProfileIds =
    profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID ? linkedProfileIds : uniqueIds([...linkedProfileIds, profileId]);
  return {
    ...state,
    workspaceProfileIds: { ...state.workspaceProfileIds, [workspaceId]: nextLinkedProfileIds },
    activeProfileIdsByWorkspace: { ...state.activeProfileIdsByWorkspace, [workspaceId]: profileId },
  };
}

export function createCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  input: { name: string; icon: CustomKeyboardIcon },
): CustomKeyboardState {
  if (!isCustomKeyboardProfileNameValid(input.name)) return state;
  const profile: CustomKeyboardProfile = {
    ...createDefaultCustomKeyboardProfile(),
    id: nextProfileId(state.profiles),
    name: input.name.trim(),
    icon: input.icon,
  };
  return selectCustomKeyboardProfile({ ...state, profiles: [...state.profiles, profile] }, workspaceId, profile.id);
}

export function duplicateCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  const source = state.profiles.find((profile) => profile.id === profileId);
  if (!source) return state;
  const profile: CustomKeyboardProfile = {
    ...source,
    id: nextProfileId(state.profiles),
    name: nextDuplicateProfileName(source.name, state.profiles),
    libraryKeys: source.libraryKeys.map((key) => cloneCustomKeyboardKey(key)),
    layout: cloneCustomKeyboardLayout(source.layout),
    shortcutKeyIds: [...source.shortcutKeyIds],
  };
  return selectCustomKeyboardProfile({ ...state, profiles: [...state.profiles, profile] }, workspaceId, profile.id);
}

function nextDuplicateProfileName(sourceName: string, profiles: readonly CustomKeyboardProfile[]): string {
  const existingNames = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const baseName = `${sourceName} Copy`.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH).trim();
  if (!existingNames.has(baseName.toLowerCase())) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${baseName.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
  return `Profile ${profiles.length + 1}`.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH);
}

export function deleteCustomKeyboardProfile(state: CustomKeyboardState, profileId: string): CustomKeyboardState {
  if (profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || !state.profiles.some((profile) => profile.id === profileId)) {
    return state;
  }
  const profiles = state.profiles.filter((profile) => profile.id !== profileId);
  const workspaceProfileIds = Object.fromEntries(
    Object.entries(state.workspaceProfileIds).flatMap(([id, linkedProfileIds]) => {
      const nextIds = linkedProfileIds.filter((linkedProfileId) => linkedProfileId !== profileId);
      return nextIds.length > 0 ? [[id, nextIds]] : [];
    }),
  );
  const activeProfileIdsByWorkspace = Object.fromEntries(
    Object.entries(state.activeProfileIdsByWorkspace).flatMap(([id, activeId]) =>
      activeId === profileId ? [[id, DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID]] : [[id, activeId]],
    ),
  );
  return {
    version: CUSTOM_KEYBOARD_STATE_VERSION,
    profiles,
    workspaceProfileIds,
    activeProfileIdsByWorkspace,
    globalActiveProfileId:
      state.globalActiveProfileId === profileId ? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID : state.globalActiveProfileId,
  };
}

export function toggleCustomKeyboardProfileLink(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  if (
    !workspaceId ||
    profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID ||
    !state.profiles.some((profile) => profile.id === profileId)
  ) {
    return state;
  }
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  if (linkedProfileIds.includes(profileId)) {
    const nextLinkedProfileIds = linkedProfileIds.filter((linkedProfileId) => linkedProfileId !== profileId);
    const activeProfileIdsByWorkspace =
      state.activeProfileIdsByWorkspace[workspaceId] === profileId
        ? {
            ...state.activeProfileIdsByWorkspace,
            [workspaceId]: nextLinkedProfileIds[0] ?? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
          }
        : state.activeProfileIdsByWorkspace;
    const workspaceProfileIds = { ...state.workspaceProfileIds };
    if (nextLinkedProfileIds.length > 0) workspaceProfileIds[workspaceId] = nextLinkedProfileIds;
    else delete workspaceProfileIds[workspaceId];
    return { ...state, workspaceProfileIds, activeProfileIdsByWorkspace };
  }
  return {
    ...state,
    workspaceProfileIds: { ...state.workspaceProfileIds, [workspaceId]: [...linkedProfileIds, profileId] },
  };
}

function validProfileIcon(value: unknown): CustomKeyboardIcon | null {
  return isCustomKeyboardIcon(value) ? value : null;
}

function isUserDefinedCustomKeyboardKey(key: CustomKeyboardKey): boolean {
  return key.category === "shortcuts" && key.id.startsWith("custom-shortcut-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function validKeyArray(value: unknown): CustomKeyboardKey[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((key): key is CustomKeyboardKey => {
    if (!isRecord(key)) return false;
    if (
      typeof key.id !== "string" ||
      (key.category !== "abc" &&
        key.category !== "123" &&
        key.category !== "special" &&
        key.category !== "shortcuts") ||
      typeof key.accessibleLabel !== "string" ||
      (key.icon !== undefined && !isCustomKeyboardIcon(key.icon)) ||
      (key.label !== undefined && typeof key.label !== "string") ||
      !isRecord(key.activation)
    ) {
      return false;
    }
    return validKeyActivation(key.activation);
  });
}

function validKeyActivation(value: Record<string, unknown>): value is CustomKeyboardKey["activation"] {
  switch (value.type) {
    case "sequence":
      return validSequence(value.sequence) !== null;
    case "modifier":
      return isCustomKeyboardModifier(value.modifier);
    case "native":
      return isCustomKeyboardNativeAction(value.action);
    case "terminal":
      return isCustomKeyboardTerminalAction(value.action);
    case "directional-flick":
      return true;
    case "surface":
      return value.surface === "clipboard" || value.surface === "profile";
    default:
      return false;
  }
}

function validSequence(value: unknown): CustomKeyboardSequence | null {
  if (!Array.isArray(value) || !value.every(validSequenceToken)) return null;
  return value;
}

function validSequenceToken(value: unknown): value is CustomKeyboardSequenceToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<CustomKeyboardSequenceToken>;
  if (token.type === "text") return typeof token.value === "string";
  if (token.type !== "key" || typeof token.key !== "string" || token.key.length === 0) return false;
  return (
    token.modifiers === undefined || (Array.isArray(token.modifiers) && token.modifiers.every(isCustomKeyboardModifier))
  );
}

function isCustomKeyboardModifier(value: unknown): value is CustomKeyboardModifier {
  return value === "ctrl" || value === "alt" || value === "shift";
}

function isCustomKeyboardIcon(value: unknown): value is CustomKeyboardIcon {
  return customKeyboardIconOptions.some((option) => option.value === value);
}

function isCustomKeyboardNativeAction(value: unknown): value is CustomKeyboardNativeAction {
  return (
    value === "pick-photo" || value === "capture-photo" || value === "scan-qr" || value === "toggle-standard-keyboard"
  );
}

function validNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
