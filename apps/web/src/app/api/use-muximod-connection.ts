import { useMemo, useState } from "react";
import {
  type BrowserConnectionProfile,
  connectionForProfile,
  readBrowserConnectionProfile,
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
  const [profile] = useState<BrowserConnectionProfile | null>(() => readBrowserConnectionProfile());
  const [connection] = useState<MuximodConnection | undefined>(() => connectionForProfile(profile));
  const utils = useMemo(() => muximodQueryUtils(connection ?? unconfiguredMuximodConnection), [connection]);

  return {
    profile,
    connection,
    utils,
    connectionKey: muximodConnectionKey(connection),
  };
}
