import { Preferences, type PreferencesPlugin } from "@capacitor/preferences";

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard";

type BrowserStorage = Pick<Storage, "getItem" | "setItem">;
type PreferencesStore = Pick<PreferencesPlugin, "get" | "set">;

const serializedWriteQueues = new Map<string, Promise<void>>();

export type CustomKeyboardStorage = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

/** Serializes persistence writes so an older asynchronous write cannot finish last. */
export function createSerializedCustomKeyboardStorage(
  storage: CustomKeyboardStorage,
  key = CUSTOM_KEYBOARD_STORAGE_KEY,
): CustomKeyboardStorage {
  return {
    async read() {
      await waitForSerializedWrites(key);
      return storage.read();
    },
    write(value) {
      const previous = serializedWriteQueues.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => storage.write(value));
      serializedWriteQueues.set(key, next);
      return next.finally(() => {
        if (serializedWriteQueues.get(key) === next) serializedWriteQueues.delete(key);
      });
    },
  };
}

async function waitForSerializedWrites(key: string): Promise<void> {
  while (true) {
    const pending = serializedWriteQueues.get(key);
    if (!pending) return;
    await pending.catch(() => undefined);
    if (serializedWriteQueues.get(key) === pending) return;
  }
}

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
