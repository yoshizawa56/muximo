import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { pairBrowserFromQr, parsePairingQrPayload } from "../../app/api/browser-auth";
import {
  clearBrowserConnectionProfile,
  readBrowserConnectionProfile,
  saveBrowserConnectionProfile,
} from "../../app/api/connection-profile-store";
import { type MuximoAppInfo, muximoBridge, muximoFallbackAppInfo } from "../../platform/muximo-bridge";

export type SettingsViewModel = {
  appInfo: MuximoAppInfo;
  hasSavedProfile: boolean;
  isScanningQr: boolean;
  isPairingQr: boolean;
  pairingMessage: string | null;
  errorMessage: string | null;
  onClear: () => void;
  onBack: () => void;
  onOpenQrScanner: () => void;
  onCloseQrScanner: () => void;
  onQrValue: (value: string) => void;
};

export function useSettingsViewModel(): SettingsViewModel {
  const navigate = useNavigate();
  const [profile, setProfile] = useState(() => readBrowserConnectionProfile());
  const [isScanningQr, setIsScanningQr] = useState(false);
  const [isPairingQr, setIsPairingQr] = useState(false);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<MuximoAppInfo>(muximoFallbackAppInfo);

  useEffect(() => {
    let disposed = false;
    void muximoBridge
      .getAppInfo()
      .then((nextAppInfo) => {
        if (!disposed) setAppInfo(nextAppInfo);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  return {
    appInfo,
    hasSavedProfile: Boolean(profile),
    isScanningQr,
    isPairingQr,
    pairingMessage,
    errorMessage,
    onClear: () => {
      clearBrowserConnectionProfile();
      setProfile(null);
      void navigate({ to: "/settings" });
    },
    onBack: () => {
      void navigate({ to: "/terminals" });
    },
    onOpenQrScanner: () => {
      setErrorMessage(null);
      setPairingMessage(null);
      setIsScanningQr(true);
    },
    onCloseQrScanner: () => setIsScanningQr(false),
    onQrValue: (value) => {
      if (isPairingQr) return;
      try {
        parsePairingQrPayload(value);
      } catch (error: unknown) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
        return;
      }
      setIsScanningQr(false);
      setIsPairingQr(true);
      setPairingMessage("Checking QR code…");
      setErrorMessage(null);
      void pairBrowserFromQr(value, {
        deviceName: "",
        onProgress: (progress) => {
          if (progress.phase === "claiming") setPairingMessage("Preparing to register device…");
          else if (progress.phase === "awaiting_approval") setPairingMessage("Waiting for approval from muximod…");
          else setPairingMessage("Registered. Connecting…");
        },
      })
        .then((result) => {
          const nextProfile = saveBrowserConnectionProfile({
            name: result.deviceName,
            muximodBaseUrl: result.payload.muximodBaseUrl,
            serverId: result.serverId,
          });
          setProfile(nextProfile);
          void navigate({ to: "/terminals" });
        })
        .catch((error: unknown) => setErrorMessage(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          setIsPairingQr(false);
          setPairingMessage(null);
        });
    },
  };
}
