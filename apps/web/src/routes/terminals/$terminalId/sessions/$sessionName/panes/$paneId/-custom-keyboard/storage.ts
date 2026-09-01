import { Preferences, type PreferencesPlugin } from "@capacitor/preferences";

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard";

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;
type PreferencesStore = Pick<PreferencesPlugin, "get" | "set">;

export type CustomKeyboardStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

export function createCustomKeyboardStorage(
  preferences: PreferencesStore = Preferences,
  browserStorage: BrowserStorage | undefined = getBrowserStorage(),
): CustomKeyboardStorage {
  return {
    async read() {
      const currentPreferenceValue = await readPreferenceValue(preferences, CUSTOM_KEYBOARD_STORAGE_KEY);
      if (currentPreferenceValue !== null) return currentPreferenceValue;
      return readBrowserValue(browserStorage, CUSTOM_KEYBOARD_STORAGE_KEY);
    },
    async write(value) {
      try {
        await preferences.set({ key: CUSTOM_KEYBOARD_STORAGE_KEY, value });
      } catch {
        try {
          browserStorage?.setItem(CUSTOM_KEYBOARD_STORAGE_KEY, value);
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

function readBrowserValue(storage: BrowserStorage | undefined, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function getBrowserStorage(): BrowserStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
