import { Preferences, type PreferencesPlugin } from "@capacitor/preferences";

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v3";
export const PREVIOUS_CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v2";
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

      for (const legacyKey of [PREVIOUS_CUSTOM_KEYBOARD_STORAGE_KEY, LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY]) {
        const legacyPreferenceValue = await readPreferenceValue(preferences, legacyKey);
        if (legacyPreferenceValue !== null) {
          await migratePreferenceValue(preferences, legacyKey, legacyPreferenceValue);
          return legacyPreferenceValue;
        }
      }

      const currentBrowserValue = readLegacyValue(legacyStorage, CUSTOM_KEYBOARD_STORAGE_KEY);
      if (currentBrowserValue !== null) return currentBrowserValue;

      for (const legacyKey of [PREVIOUS_CUSTOM_KEYBOARD_STORAGE_KEY, LEGACY_CUSTOM_KEYBOARD_STORAGE_KEY]) {
        const legacyBrowserValue = readLegacyValue(legacyStorage, legacyKey);
        if (legacyBrowserValue !== null) {
          await migrateBrowserValue(preferences, legacyStorage, legacyKey, legacyBrowserValue);
          return legacyBrowserValue;
        }
      }
      return null;
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

async function migratePreferenceValue(preferences: PreferencesStore, sourceKey: string, value: string): Promise<void> {
  try {
    await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
    await preferences.remove({ key: sourceKey });
  } catch {
    // Keep the legacy value available when migration cannot be completed yet.
  }
}

async function migrateBrowserValue(
  preferences: PreferencesStore,
  storage: LegacyStorage | undefined,
  sourceKey: string,
  value: string,
): Promise<void> {
  try {
    await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
    storage?.removeItem(sourceKey);
  } catch {
    try {
      storage?.setItem(CUSTOM_KEYBOARD_STORAGE_KEY, value);
      storage?.removeItem(sourceKey);
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
