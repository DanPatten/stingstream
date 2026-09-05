/**
 * Web stub for `react-native-google-cast` (StingStream M2 web target).
 *
 * The package wraps the Android/iOS Cast sender SDKs; there is no web backend
 * (a browser would use the Cast Web Sender API, `cast.framework`, which is a
 * different surface entirely and out of scope for the spike). Metro resolves
 * this file instead whenever `platform === "web"` — see `webModuleStubs` in
 * `metro.config.js`. Native bundles never see it.
 *
 * `CastButton` renders nothing, the hooks report "no device / no session", and
 * the imperative API resolves to a state that makes callers fall through to
 * local playback, so cast affordances simply do not appear on web.
 */

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
export type RemoteMediaClient = Record<string, any>;
export type CastSession = Record<string, any>;

/** Renders nothing: web has no cast sender, so the affordance is absent. */
export const CastButton = (_props: Record<string, any>): null => null;

const noSubscription = { remove: () => {} };

const sessionManager = {
  getCurrentCastSession: async (): Promise<CastSession | null> => null,
  getCurrentSession: async (): Promise<CastSession | null> => null,
  getSessionState: async () => CastState.NO_DEVICES_AVAILABLE,
  endCurrentSession: async (_stopCasting?: boolean) => undefined,
  startSession: async (_deviceId: string) => undefined,
  onSessionStarted: (_l: (...a: any[]) => void) => noSubscription,
  onSessionEnded: (_l: (...a: any[]) => void) => noSubscription,
  onSessionResumed: (_l: (...a: any[]) => void) => noSubscription,
  onSessionStarting: (_l: (...a: any[]) => void) => noSubscription,
  onSessionSuspended: (_l: (...a: any[]) => void) => noSubscription,
};

const discoveryManager = {
  startDiscovery: async () => undefined,
  stopDiscovery: async () => undefined,
  onDevicesUpdated: (_l: (...a: any[]) => void) => noSubscription,
};

export const CastContext = {
  getPlayServicesState: async () => PlayServicesState.MISSING,
  showPlayServicesErrorDialog: async (_state?: PlayServicesState) => false,
  showCastDialog: async () => undefined,
  showExpandedControls: async () => undefined,
  getCastState: async () => CastState.NO_DEVICES_AVAILABLE,
  getSessionManager: () => sessionManager,
  getDiscoveryManager: () => discoveryManager,
  setMuted: async (_muted: boolean) => undefined,
  setVolume: async (_volume: number) => undefined,
  Provider: ({ children }: { children?: any }) => children ?? null,
};

export const useCastState = (): CastState => CastState.NO_DEVICES_AVAILABLE;
export const useCastDevice = (): Device | null => null;
export const useDevices = (): Device[] => [];
export const useRemoteMediaClient = (): RemoteMediaClient | null => null;
export const useMediaStatus = (): MediaStatus | null => null;
export const useStreamPosition = (_interval?: number): number | null => null;
export const useCastSession = (): CastSession | null => null;

export default CastContext;
