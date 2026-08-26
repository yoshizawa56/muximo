import { useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  type BrowserConnectionProfile,
  connectionForProfile,
  selectBrowserConnectionProfile,
} from "./connection-profile-store";
import type { MuximodConnection } from "./muximod-client";
import { muximodConnectionKey, unconfiguredMuximodConnection } from "./muximod-client";
import { type MuximodQueryUtils, muximodQueryUtils } from "./orpc-utils";

export type MuximodConnectionState = {
  profile: BrowserConnectionProfile | null;
  connection: MuximodConnection | undefined;
  /** Query utilities for the current connection; built against the
   *  unconfigured sentinel when no profile exists so hooks never assert. */
  utils: MuximodQueryUtils;
  connectionKey: string;
};

export function useMuximodConnection(): MuximodConnectionState {
  const search = useSearch({ strict: false });
  const profileId = typeof search.connection === "string" ? search.connection : undefined;
  const profile = useMemo(() => selectBrowserConnectionProfile(profileId), [profileId]);
  const connection = useMemo(() => connectionForProfile(profile), [profile]);
  const utils = useMemo(() => muximodQueryUtils(connection ?? unconfiguredMuximodConnection), [connection]);

  return {
    profile,
    connection,
    utils,
    connectionKey: muximodConnectionKey(connection),
  };
}
