/**
 * Web stub for `react-native-track-player` (StingStream M2 web target).
 *
 * The upstream package is a git dependency whose published `main` field points
 * at a `lib/` directory that only exists after its `prepare` script has run,
 * and its implementation is a pure native module with no web backend. Metro
 * resolves this file instead whenever `platform === "web"` (see the
 * `webModuleStubs` map in `metro.config.js`); native bundles are untouched and
 * keep resolving the real package through its `react-native` entry field.
 *
 * Background/queued music playback is therefore "not available on web" for now:
 * every command is an inert promise and every hook reports a stopped player, so
 * `MusicPlayerProvider` / `MusicPlaybackEngine` mount and render without
 * throwing. Replacing this with an `<audio>`-backed engine is a self-contained
 * follow-up — the surface below is exactly what the app calls.
 */

export enum Capability {
  Play = 1,
  PlayFromId = 2,
  PlayFromSearch = 3,
  Pause = 4,
  Stop = 5,
  SeekTo = 6,
  Skip = 7,
  SkipToNext = 8,
  SkipToPrevious = 9,
  JumpForward = 10,
  JumpBackward = 11,
  SetRating = 12,
  Like = 13,
  Dislike = 14,
  Bookmark = 15,
}

export enum State {
  None = "none",
  Ready = "ready",
  Playing = "playing",
  Paused = "paused",
  Stopped = "stopped",
  Ended = "ended",
  Buffering = "buffering",
  Loading = "loading",
  Error = "error",
}

export enum RepeatMode {
  Off = 0,
  Track = 1,
  Queue = 2,
}

export enum AppKilledPlaybackBehavior {
  ContinuePlayback = "continue-playback",
  PausePlayback = "pause-playback",
  StopPlaybackAndRemoveNotification = "stop-playback-and-remove-notification",
}

export enum Event {
  PlaybackState = "playback-state",
  PlaybackError = "playback-error",
  PlaybackActiveTrackChanged = "playback-active-track-changed",
  PlaybackQueueEnded = "playback-queue-ended",
  PlaybackProgressUpdated = "playback-progress-updated",
  PlaybackPlayWhenReadyChanged = "playback-play-when-ready-changed",
  RemotePlay = "remote-play",
  RemotePause = "remote-pause",
  RemoteStop = "remote-stop",
  RemoteNext = "remote-next",
  RemotePrevious = "remote-previous",
  RemoteSeek = "remote-seek",
  RemoteJumpForward = "remote-jump-forward",
  RemoteJumpBackward = "remote-jump-backward",
  RemoteDuck = "remote-duck",
}

export enum IOSCategory {
  Playback = "playback",
}
export enum IOSCategoryMode {
  Default = "default",
}
export enum IOSCategoryOptions {
  MixWithOthers = "mixWithOthers",
}
export enum PitchAlgorithm {
  Linear = "linear",
  Music = "music",
  Voice = "voice",
}
export enum RatingType {
  Heart = 1,
}

export type Track = Record<string, any> & { url?: string; id?: string };
export type Progress = {
  position: number;
  duration: number;
  buffered: number;
};
export type PlaybackState = { state: State };
export type PlaybackActiveTrackChangedEvent = {
  lastTrack?: Track;
  lastPosition?: number;
  lastIndex?: number;
  index?: number;
  track?: Track;
};
export type PlaybackErrorEvent = { code: string; message: string };
export type PlaybackProgressUpdatedEvent = Progress & { track: number };
export type EmitterSubscription = { remove: () => void };
export type AddTrack = Track;
export type UpdateOptions = Record<string, any>;
export type ServiceHandler = () => Promise<void>;

const EMPTY_PROGRESS: Progress = { position: 0, duration: 0, buffered: 0 };
const noSubscription: EmitterSubscription = { remove: () => {} };

/**
 * `MusicPlayerProvider` treats a rejected setup as fatal, so every command
 * resolves. Reads return the shape callers destructure, never `undefined`.
 */
const TrackPlayer = {
  setupPlayer: async (_options?: Record<string, any>) => undefined,
  updateOptions: async (_options?: UpdateOptions) => undefined,
  registerPlaybackService: (_factory: () => ServiceHandler) => undefined,
  addEventListener: (_event: Event, _listener: (...args: any[]) => void) =>
    noSubscription,
  add: async (_tracks: Track | Track[], _insertBeforeIndex?: number) => 0,
  remove: async (_indexes: number | number[]) => undefined,
  move: async (_fromIndex: number, _toIndex: number) => undefined,
  reset: async () => undefined,
  play: async () => undefined,
  pause: async () => undefined,
  stop: async () => undefined,
  seekTo: async (_seconds: number) => undefined,
  seekBy: async (_offset: number) => undefined,
  skip: async (_index: number, _initialPosition?: number) => undefined,
  skipToNext: async (_initialPosition?: number) => undefined,
  skipToPrevious: async (_initialPosition?: number) => undefined,
  setRepeatMode: async (_mode: RepeatMode) => undefined,
  getRepeatMode: async () => RepeatMode.Off,
  setVolume: async (_level: number) => undefined,
  getVolume: async () => 1,
  setRate: async (_rate: number) => undefined,
  getRate: async () => 1,
  getQueue: async (): Promise<Track[]> => [],
  setQueue: async (_tracks: Track[]) => undefined,
  getActiveTrack: async (): Promise<Track | undefined> => undefined,
  getActiveTrackIndex: async (): Promise<number | undefined> => undefined,
  getProgress: async (): Promise<Progress> => ({ ...EMPTY_PROGRESS }),
  getPlaybackState: async (): Promise<PlaybackState> => ({ state: State.None }),
  getTrack: async (_index: number): Promise<Track | undefined> => undefined,
  updateMetadataForTrack: async (_index: number, _metadata: Track) => undefined,
  updateNowPlayingMetadata: async (_metadata: Track) => undefined,
  retry: async () => undefined,
};

export const useProgress = (_updateInterval?: number): Progress => ({
  ...EMPTY_PROGRESS,
});
export const usePlaybackState = (): PlaybackState => ({ state: State.None });
export const useActiveTrack = (): Track | undefined => undefined;
export const usePlayWhenReady = (): boolean => false;
export const useIsPlaying = () => ({
  playing: false,
  bufferingDuringPlay: false,
});
export const useTrackPlayerEvents = (
  _events: Event[],
  _handler: (...args: any[]) => void,
) => undefined;

export default TrackPlayer;
