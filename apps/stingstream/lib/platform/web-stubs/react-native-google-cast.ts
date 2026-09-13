/**
 * Web build of `react-native-google-cast`.
 *
 * The package wraps the Android and iOS Cast sender SDKs and has no web backend. Metro resolves
 * this file instead whenever `platform === "web"` (`webModuleStubs` in `metro.config.js`), so
 * native bundles never see it.
 *
 * It used to be an inert stub. It is now the same surface backed by the Cast Web Sender, through
 * `lib/cast/webCastSession.ts`, so every caller written for the phone — `PlayButton`,
 * `useMusicCast`, `components/Chromecast.tsx`, now-playing — casts from a browser unchanged.
 *
 * Only what the app calls is real. The session listeners, volume and the device list have no caller
 * on web and stay no-ops; a browser has no device list to give anyway, because Chrome draws its own
 * picker.
 */

import { createElement, useSyncExternalStore } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { HeaderIcon } from "@/components/common/HeaderIcon";
import i18n from "@/i18n";
import { webCastSession } from "@/lib/cast/webCastSession";

export enum CastState {
  NO_DEVICES_AVAILABLE = "noDevicesAvailable",
  NOT_CONNECTED = "notConnected",
  CONNECTING = "connecting",
  CONNECTED = "connected",
}

export enum PlayServicesState {
  SUCCESS = "success",
  DISABLED = "disabled",
  INVALID = "invalid",
  MISSING = "missing",
  UPDATING = "updating",
  UPDATE_REQUIRED = "updateRequired",
}

export enum MediaStreamType {
  BUFFERED = "buffered",
  LIVE = "live",
  NONE = "none",
}

export enum MediaHlsSegmentFormat {
  AAC = "aac",
  AC3 = "ac3",
  E_AC3 = "e_ac3",
  FMP4 = "fmp4",
  MP3 = "mp3",
  TS = "ts",
  TS_AAC = "ts_aac",
}

export enum MediaHlsVideoSegmentFormat {
  FMP4 = "fmp4",
  MPEG2_TS = "mpeg2_ts",
}

export enum MediaPlayerState {
  BUFFERING = "buffering",
  IDLE = "idle",
  LOADING = "loading",
  PAUSED = "paused",
  PLAYING = "playing",
}

export type MediaTrack = Record<string, any>;
export type MediaInfo = Record<string, any>;
export type MediaStatus = Record<string, any>;
export type Device = Record<string, any>;
export type RemoteMediaClient = typeof webCastSession.client;
export type CastSession = Record<string, any>;

const useSnapshot = () =>
  useSyncExternalStore(
    webCastSession.subscribe,
    webCastSession.getSnapshot,
    webCastSession.getSnapshot,
  );

const noSubscription = { remove: () => {} };

const castSession: CastSession = {
  client: webCastSession.client,
  getRemoteMediaClient: async () => webCastSession.client,
  endSession: (stopCasting?: boolean) => webCastSession.endSession(stopCasting),
};

const isConnected = () =>
  webCastSession.getSnapshot().castState === CastState.CONNECTED;

const sessionManager = {
  getCurrentCastSession: async (): Promise<CastSession | null> =>
    isConnected() ? castSession : null,
  getCurrentSession: async (): Promise<CastSession | null> =>
    isConnected() ? castSession : null,
  getSessionState: async () => webCastSession.getSnapshot().castState,
  endCurrentSession: (stopCasting?: boolean) =>
    webCastSession.endSession(stopCasting),
  startSession: async (_deviceId: string) => {
    await webCastSession.requestSession();
  },
  onSessionStarted: (_l: (...a: any[]) => void) => noSubscription,
  onSessionEnded: (_l: (...a: any[]) => void) => noSubscription,
  onSessionResumed: (_l: (...a: any[]) => void) => noSubscription,
  onSessionStarting: (_l: (...a: any[]) => void) => noSubscription,
  onSessionSuspended: (_l: (...a: any[]) => void) => noSubscription,
};

const discoveryManager = {
  startDiscovery: async () => {
    await webCastSession.ensureReady();
  },
  stopDiscovery: async () => undefined,
  onDevicesUpdated: (_l: (...a: any[]) => void) => noSubscription,
};

/** The dialog that says why, mounted by the web shells (`components/cast/CastControlsSheet.tsx`). */
const reportUnavailable = () => {
  webCastSession.showUnavailable();
};

export const CastContext = {
  getPlayServicesState: async () =>
    (await webCastSession.ensureReady())
      ? PlayServicesState.SUCCESS
      : PlayServicesState.MISSING,
  showPlayServicesErrorDialog: async (_state?: PlayServicesState) => {
    reportUnavailable();
    return true;
  },
  showCastDialog: async () => {
    if ((await webCastSession.requestSession()) === "unavailable") {
      reportUnavailable();
    }
  },
  /** The phone SDK's full-screen controller; on web, the controls sheet the shell mounts. */
  showExpandedControls: async () => {
    webCastSession.setControlsOpen(true);
  },
  getCastState: async () => {
    await webCastSession.ensureReady();
    return webCastSession.getSnapshot().castState;
  },
  getSessionManager: () => sessionManager,
  getDiscoveryManager: () => discoveryManager,
  setMuted: async (_muted: boolean) => undefined,
  setVolume: async (_volume: number) => undefined,
  Provider: ({ children }: { children?: any }) => children ?? null,
};

/** A plain cast glyph that opens the picker. Only now-playing mounts one directly. */
export const CastButton = ({
  style,
}: {
  style?: StyleProp<ViewStyle> & { tintColor?: string };
}) => {
  const { tintColor, ...rest } = (style ?? {}) as ViewStyle & {
    tintColor?: string;
  };
  return createElement(
    Pressable,
    {
      accessibilityRole: "button",
      accessibilityLabel: i18n.t("shell.cast_to_device"),
      onPress: () => void CastContext.showCastDialog(),
      style: rest,
    },
    createElement(HeaderIcon, { name: "cast", tintColor, size: 24 }),
  );
};

export const useCastState = (): CastState =>
  useSnapshot().castState as CastState;

export const useCastDevice = (): Device | null => {
  const { deviceName } = useSnapshot();
  return deviceName ? { deviceId: deviceName, friendlyName: deviceName } : null;
};

export const useDevices = (): Device[] => [];

export const useRemoteMediaClient = (): RemoteMediaClient | null =>
  useSnapshot().castState === CastState.CONNECTED
    ? webCastSession.client
    : null;

export const useMediaStatus = (): MediaStatus | null =>
  useSnapshot().mediaStatus;

export const useStreamPosition = (_interval?: number): number | null =>
  useSnapshot().mediaStatus?.streamPosition ?? null;

export const useCastSession = (): CastSession | null =>
  useSnapshot().castState === CastState.CONNECTED ? castSession : null;

export default CastContext;
