import { Preferences, type PreferencesPlugin } from "@capacitor/preferences";

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v1";

type LegacyStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type PreferencesStore = Pick<PreferencesPlugin, "get" | "set">;

export type CustomKeyboardStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

export function createCustomKeyboardStorage(
  preferences: PreferencesStore = Preferences,
  legacyStorage: LegacyStorage | undefined = getLegacyStorage(),
): CustomKeyboardStorage {
  return {
    async read() {
      try {
        const current = await preferences.get({ key: CUSTOM_KEYBOARD_STORAGE_KEY });
        if (current.value !== null) return current.value;
      } catch {
        // Fall back to the legacy browser storage when the native plugin is unavailable.
      }

      const legacyValue = readLegacyValue(legacyStorage);
      if (legacyValue === null) return null;

      try {
        await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value: legacyValue });
        legacyStorage?.removeItem(CUSTOM_KEYBOARD_STORAGE_KEY);
      } catch {
        // Keep the legacy value available when migration cannot be completed yet.
      }
      return legacyValue;
    },
    async write(value) {
      try {
        await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
      } catch {
        try {
          legacyStorage?.setItem(CUSTOM_KEYBOARD_STORAGE_KEY, value);
        } catch {
          // Storage may be unavailable in private browsing or an embedded webview.
        }
      }
    },
  };
}

function readLegacyValue(storage: LegacyStorage | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(CUSTOM_KEYBOARD_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getLegacyStorage(): LegacyStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
