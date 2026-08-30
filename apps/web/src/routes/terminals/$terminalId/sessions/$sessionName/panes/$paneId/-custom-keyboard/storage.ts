import { Preferences, type PreferencesPlugin } from "@capacitor/preferences";

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v2";
export const LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v1";

type LegacyStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type PreferencesStore = Pick<PreferencesPlugin, "get" | "remove" | "set">;

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
      const currentPreferenceValue = await readPreferenceValue(preferences, CUSTOM_KEYBOARD_STORAGE_KEY);
      if (currentPreferenceValue !== null) return currentPreferenceValue;

      const legacyPreferenceValue = await readPreferenceValue(preferences, LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY);
      if (legacyPreferenceValue !== null) {
        await migratePreferenceValue(preferences, legacyPreferenceValue);
        return legacyPreferenceValue;
      }

      const currentBrowserValue = readLegacyValue(legacyStorage, CUSTOM_KEYBOARD_STORAGE_KEY);
      if (currentBrowserValue !== null) return currentBrowserValue;

      const legacyBrowserValue = readLegacyValue(legacyStorage, LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY);
      if (legacyBrowserValue === null) return null;

      await migrateBrowserValue(preferences, legacyStorage, legacyBrowserValue);
      return legacyBrowserValue;
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

async function readPreferenceValue(preferences: PreferencesStore, key: string): Promise<string | null> {
  try {
    return (await preferences.get({ key })).value;
  } catch {
    return null;
  }
}

async function migratePreferenceValue(preferences: PreferencesStore, value: string): Promise<void> {
  try {
    await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
    await preferences.remove({ key: LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY });
  } catch {
    // Keep the legacy value available when migration cannot be completed yet.
  }
}

async function migrateBrowserValue(
  preferences: PreferencesStore,
  storage: LegacyStorage | undefined,
  value: string,
): Promise<void> {
  try {
    await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
    storage?.removeItem(LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY);
  } catch {
    try {
      storage?.setItem(CUSTOM_KEYBOARD_STORAGE_KEY, value);
      storage?.removeItem(LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY);
    } catch {
      // Storage may be unavailable in private browsing or an embedded webview.
    }
  }
}

function readLegacyValue(storage: LegacyStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
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
