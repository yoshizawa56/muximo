import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type BrowserPairingPreview, inspectPairingQr, pairBrowserFromQr } from "../../app/api/browser-auth";
import {
  type BrowserConnectionProfile,
  defaultConnectionProfileName,
  readBrowserConnectionProfiles,
  removeBrowserConnectionProfile,
  renameBrowserConnectionProfile,
  saveBrowserConnectionProfile,
} from "../../app/api/connection-profile-store";
import { muximodErrorMessage } from "../../app/api/muximod-error.js";
import { type MuximoAppInfo, muximoBridge, muximoFallbackAppInfo } from "../../platform/muximo-bridge";

export type SettingsViewModel = {
  appInfo: MuximoAppInfo;
  profiles: BrowserConnectionProfile[];
  activeProfileId: string | null;
  isScanningQr: boolean;
  isPreparingPairing: boolean;
  pairingPreview: BrowserPairingPreview | null;
  pairingName: string;
  isPairingQr: boolean;
  pairingMessage: string | null;
  errorMessage: string | null;
  editingProfileId: string | null;
  editingProfileName: string;
  onBack: () => void;
  onOpenQrScanner: () => void;
  onCloseQrScanner: () => void;
  onQrValue: (value: string) => void;
  onPairingNameChange: (value: string) => void;
  onConfirmPairing: () => void;
  onCancelPairing: () => void;
  onSelectProfile: (profileId: string) => void;
  onRemoveProfile: (profileId: string) => void;
  onStartRename: (profileId: string) => void;
  onRenameChange: (value: string) => void;
  onCancelRename: () => void;
  onSaveRename: () => void;
};

export function useSettingsViewModel(): SettingsViewModel {
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const [profiles, setProfiles] = useState(() => readBrowserConnectionProfiles());
  const [isScanningQr, setIsScanningQr] = useState(false);
  const [isPreparingPairing, setIsPreparingPairing] = useState(false);
  const [pairingPreview, setPairingPreview] = useState<BrowserPairingPreview | null>(null);
  const [pairingName, setPairingName] = useState("");
  const [isPairingQr, setIsPairingQr] = useState(false);
  const [pairingMessage, setPairingMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [editingProfileName, setEditingProfileName] = useState("");
  const [appInfo, setAppInfo] = useState<MuximoAppInfo>(muximoFallbackAppInfo);
  const pendingPairingCode = useRef<string | null>(null);

  const activeProfileId =
    typeof search.connection === "string" && profiles.some((profile) => profile.id === search.connection)
      ? search.connection
      : (profiles[0]?.id ?? null);

  const refreshProfiles = () => setProfiles(readBrowserConnectionProfiles());
  const clearPairingPreview = () => {
    pendingPairingCode.current = null;
    setPairingPreview(null);
    setPairingName("");
  };

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
    profiles,
    activeProfileId,
    isScanningQr,
    isPreparingPairing,
    pairingPreview,
    pairingName,
    isPairingQr,
    pairingMessage,
    errorMessage,
    editingProfileId,
    editingProfileName,
    onBack: () => {
      if (!activeProfileId) return;
      void navigate({ to: "/terminals", search: { connection: activeProfileId } });
    },
    onOpenQrScanner: () => {
      clearPairingPreview();
      setErrorMessage(null);
      setPairingMessage(null);
      setIsScanningQr(true);
    },
    onCloseQrScanner: () => setIsScanningQr(false),
    onQrValue: (value) => {
      if (isPreparingPairing || isPairingQr || pendingPairingCode.current) return;
      pendingPairingCode.current = value;
      setIsScanningQr(false);
      setIsPreparingPairing(true);
      setErrorMessage(null);
      setPairingMessage("Checking QR code…");
      void inspectPairingQr(value)
        .then((preview) => {
          setPairingPreview(preview);
          setPairingName(defaultConnectionProfileName(preview.muximodBaseUrl));
        })
        .catch((error: unknown) => {
          pendingPairingCode.current = null;
          setErrorMessage(muximodErrorMessage(error));
        })
        .finally(() => {
          setIsPreparingPairing(false);
          setPairingMessage(null);
        });
    },
    onPairingNameChange: (value) => setPairingName(value),
    onConfirmPairing: () => {
      const value = pendingPairingCode.current;
      const preview = pairingPreview;
      if (!value || !preview || isPairingQr) return;
      pendingPairingCode.current = null;
      const name = pairingName.trim() || defaultConnectionProfileName(preview.muximodBaseUrl);
      setPairingName(name);
      setIsPairingQr(true);
      setPairingMessage("Preparing to register device…");
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
          const profile = saveBrowserConnectionProfile({
            name,
            muximodBaseUrl: result.payload.muximodBaseUrl,
            serverId: result.serverId,
          });
          refreshProfiles();
          clearPairingPreview();
          void navigate({ to: "/terminals", search: { connection: profile.id } });
        })
        .catch((error: unknown) => {
          clearPairingPreview();
          setErrorMessage(muximodErrorMessage(error));
        })
        .finally(() => {
          setIsPairingQr(false);
          setPairingMessage(null);
        });
    },
    onCancelPairing: () => {
      clearPairingPreview();
      setIsPreparingPairing(false);
      setIsPairingQr(false);
      setPairingMessage(null);
      setErrorMessage(null);
    },
    onSelectProfile: (profileId) => {
      void navigate({ to: "/terminals", search: { connection: profileId } });
    },
    onRemoveProfile: (profileId) => {
      removeBrowserConnectionProfile(profileId);
      refreshProfiles();
      if (profileId === activeProfileId) {
        const remainingProfile = profiles.find((profile) => profile.id !== profileId);
        void navigate({
          to: "/settings",
          search: remainingProfile ? { connection: remainingProfile.id } : { connection: undefined },
        });
      }
    },
    onStartRename: (profileId) => {
      const profile = profiles.find((candidate) => candidate.id === profileId);
      if (!profile) return;
      setErrorMessage(null);
      setEditingProfileId(profileId);
      setEditingProfileName(profile.name);
    },
    onRenameChange: (value) => setEditingProfileName(value),
    onCancelRename: () => {
      setEditingProfileId(null);
      setEditingProfileName("");
    },
    onSaveRename: () => {
      if (!editingProfileId) return;
      try {
        renameBrowserConnectionProfile(editingProfileId, editingProfileName);
        refreshProfiles();
        setEditingProfileId(null);
        setEditingProfileName("");
        setErrorMessage(null);
      } catch (error: unknown) {
        setErrorMessage(muximodErrorMessage(error));
      }
    },
  };
}
