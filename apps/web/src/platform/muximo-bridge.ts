import { App } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import webPackage from "../../package.json";

export type MuximoPlatform = "web" | "ios" | "android";
export type MuximoAppState = "active" | "background";
export type MuximoAppInfo = {
  version: string;
  build: string;
};

export const muximoFallbackAppInfo = {
  version: webPackage.version,
  build: "web",
} satisfies MuximoAppInfo;

export type MuximoBridge = {
  readonly platform: MuximoPlatform;
  readonly isNative: boolean;
  readonly capabilities: {
    appLifecycle: true;
    routeProvider: false;
    keychain: false;
    notifications: false;
    liveActivities: false;
  };
  getAppInfo(): Promise<MuximoAppInfo>;
  getAppState(): MuximoAppState;
  keyPressHaptic(): void;
  onAppStateChange(listener: (state: MuximoAppState) => void): () => void;
};

const capabilities = {
  appLifecycle: true,
  routeProvider: false,
  keychain: false,
  notifications: false,
  liveActivities: false,
} as const;

/**
 * Keeps native-only responsibilities behind one boundary. The MVP uses
 * HTTPS/WSS through Tailscale Serve, so no native route or secret bridge is
 * installed yet. App lifecycle events are still useful to reconnect the
 * foreground terminal after iOS suspends the WebView.
 */
export function createMuximoBridge(): MuximoBridge {
  const platform = normalizePlatform(Capacitor.getPlatform());
  return {
    platform,
    isNative: Capacitor.isNativePlatform(),
    capabilities,
    getAppInfo: () => readAppInfo(),
    getAppState: () => currentAppState(),
    keyPressHaptic: () => {
      if (!Capacitor.isNativePlatform()) return;
      void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
    },
    onAppStateChange: (listener) => subscribeToAppState(listener),
  };
}

export const muximoBridge = createMuximoBridge();

function normalizePlatform(platform: string): MuximoPlatform {
  if (platform === "ios" || platform === "android") return platform;
  return "web";
}

function currentAppState(): MuximoAppState {
  return typeof document === "undefined" || document.visibilityState === "visible" ? "active" : "background";
}

async function readAppInfo(): Promise<MuximoAppInfo> {
  if (!Capacitor.isNativePlatform()) return muximoFallbackAppInfo;

  try {
    const info = await App.getInfo();
    return { version: info.version, build: info.build };
  } catch {
    return muximoFallbackAppInfo;
  }
}

function subscribeToAppState(listener: (state: MuximoAppState) => void): () => void {
  if (typeof document === "undefined") return () => undefined;

  if (Capacitor.isNativePlatform()) return subscribeToNativeAppState(listener);

  const handleVisibilityChange = () => listener(currentAppState());
  document.addEventListener("visibilitychange", handleVisibilityChange);
  return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
}

function subscribeToNativeAppState(listener: (state: MuximoAppState) => void): () => void {
  let disposed = false;
  let handle: PluginListenerHandle | undefined;

  void App.addListener("appStateChange", ({ isActive }) => {
    listener(isActive ? "active" : "background");
  }).then((nextHandle) => {
    if (disposed) {
      void nextHandle.remove();
      return;
    }
    handle = nextHandle;
  });

  return () => {
    disposed = true;
    void handle?.remove();
  };
}
