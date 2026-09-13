import { CAST_SDK_LOAD_TIMEOUT_MS, CAST_SDK_URL } from "@/constants/Cast";

/**
 * Casting from a browser, behind the same shape `react-native-google-cast` has on a phone.
 *
 * The app's cast code — `PlayButton`, `useMusicCast`, the header button, now-playing — is written
 * against `react-native-google-cast`, which wraps Google's Android and iOS sender SDKs and has no
 * web build. Rather than a second cast path for the browser, the web bundle's stand-in for that
 * package (`lib/platform/web-stubs/react-native-google-cast.ts`) is a thin layer over this store,
 * which drives the Cast Web Sender (`cast.framework`). Every caller then works unchanged.
 *
 * This file holds no React and no copy, so it can be tested against a fake `cast` global.
 *
 * ## What a browser can and cannot do
 *
 * - The sender only runs on a secure page: `https://`, or `http://localhost` / `127.0.0.1`. On a
 *   plain-HTTP LAN address it reports itself unavailable. Nothing here sniffs the browser: a
 *   Firefox extension that provides the API is as good as Chrome.
 * - When it cannot start, the store records why ({@link CastUnavailableReason}) so the dialog can
 *   say something more useful than "no".
 * - The receiver is Google's Default Media Receiver, so there is nothing to register.
 * - There is no device list. Chrome draws its own picker when a session is requested, so
 *   `useDevices` stays empty on web.
 */

// The Cast SDK ships no types we depend on, and its surface is used in exactly this file.
type Sdk = any;

export type WebCastState =
  | "noDevicesAvailable"
  | "notConnected"
  | "connecting"
  | "connected";

export type WebPlayerState =
  | "idle"
  | "loading"
  | "buffering"
  | "playing"
  | "paused";

/** What the loader learned. `blocked` is the script never arriving, not the browser saying no. */
export type SdkLoadResult = "available" | "unsupported" | "blocked";

/**
 * Why casting cannot start here.
 *
 * - `insecure`: the page is not a secure context. Checked first, because on a plain-HTTP LAN
 *   address even Chrome says no, and the fix is the address rather than the browser.
 * - `unsupported`: the sender loaded and said this browser cannot cast.
 * - `blocked`: the sender script never arrived (offline, or a content blocker). Worth a retry.
 */
export type CastUnavailableReason = "insecure" | "unsupported" | "blocked";

export interface WebMediaStatus {
  /** Non-null whenever something is loaded: the header button's "open the controls" test. */
  currentItemId: number | null;
  playerState: WebPlayerState;
  /** Seconds. */
  streamPosition: number;
  mediaInfo: {
    contentId?: string;
    contentUrl?: string;
    /** Seconds. */
    streamDuration?: number;
    metadata?: { title?: string; images?: { url: string }[] };
  } | null;
}

export interface WebCastSnapshot {
  /** `unknown` until the sender has loaded, or failed to. */
  availability: "unknown" | "available" | "unavailable";
  /** Set whenever `availability` is `unavailable`. */
  unavailableReason: CastUnavailableReason | null;
  castState: WebCastState;
  deviceName: string | null;
  mediaStatus: WebMediaStatus | null;
  /** Whether the web controls sheet is open — the browser's "expanded controls". */
  controlsOpen: boolean;
  /** Whether the "casting is not available" dialog is open. */
  unavailableOpen: boolean;
}

export type RequestSessionOutcome = "connected" | "cancelled" | "unavailable";

export interface WebCastEnvironment {
  loadSdk: () => Promise<SdkLoadResult>;
  globals: () => { cast?: Sdk; chrome?: Sdk };
  /** Defaults to `globalThis.isSecureContext`, treating an environment without one as secure. */
  isSecureContext?: () => boolean;
}

const CAST_STATES: Record<string, WebCastState> = {
  NO_DEVICES_AVAILABLE: "noDevicesAvailable",
  NOT_CONNECTED: "notConnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
};

const PLAYER_STATES: Record<string, WebPlayerState> = {
  IDLE: "idle",
  PLAYING: "playing",
  PAUSED: "paused",
  BUFFERING: "buffering",
  LOADING: "loading",
};

const INITIAL: WebCastSnapshot = {
  availability: "unknown",
  unavailableReason: null,
  castState: "noDevicesAvailable",
  deviceName: null,
  mediaStatus: null,
  controlsOpen: false,
  unavailableOpen: false,
};

/** Inject Google's sender and wait for its availability callback. */
export function loadCastSdk(): Promise<SdkLoadResult> {
  const g = globalThis as Sdk;
  if (g.cast?.framework && g.chrome?.cast) return Promise.resolve("available");
  const doc = g.document;
  if (!doc?.createElement || !doc.head) return Promise.resolve("unsupported");

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: SdkLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        result === "available" && !(g.cast?.framework && g.chrome?.cast)
          ? "unsupported"
          : result,
      );
    };
    const timer = setTimeout(() => settle("blocked"), CAST_SDK_LOAD_TIMEOUT_MS);
    // The sender calls this global when it has decided, and calls it `false` in a browser that
    // cannot cast — which is the answer we want, not an error.
    const previous = g.__onGCastApiAvailable;
    g.__onGCastApiAvailable = (isAvailable: boolean) => {
      previous?.(isAvailable);
      settle(isAvailable ? "available" : "unsupported");
    };
    const script = doc.createElement("script");
    script.src = CAST_SDK_URL;
    script.async = true;
    script.onerror = () => settle("blocked");
    doc.head.appendChild(script);
  });
}

const defaultEnvironment: WebCastEnvironment = {
  loadSdk: loadCastSdk,
  globals: () => {
    const g = globalThis as Sdk;
    return { cast: g.cast, chrome: g.chrome };
  },
};

export function createWebCastSession(
  env: WebCastEnvironment = defaultEnvironment,
) {
  let snapshot: WebCastSnapshot = INITIAL;
  const listeners = new Set<() => void>();
  let ready: Promise<boolean> | null = null;
  let player: Sdk = null;
  let controller: Sdk = null;

  const isSecureContext = () =>
    env.isSecureContext
      ? env.isSecureContext()
      : (globalThis as Sdk).isSecureContext !== false;

  const set = (patch: Partial<WebCastSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const context = (): Sdk =>
    env.globals().cast?.framework?.CastContext?.getInstance?.() ?? null;
  const currentSession = (): Sdk => context()?.getCurrentSession?.() ?? null;

  const syncMedia = () => {
    if (!player?.isConnected || !player.isMediaLoaded) {
      if (snapshot.mediaStatus) set({ mediaStatus: null });
      return;
    }
    const info = player.mediaInfo;
    const media = currentSession()?.getMediaSession?.();
    set({
      mediaStatus: {
        currentItemId: media?.currentItemId ?? media?.mediaSessionId ?? 1,
        playerState:
          PLAYER_STATES[player.playerState] ??
          (player.isPaused ? "paused" : "playing"),
        streamPosition: player.currentTime ?? 0,
        mediaInfo: {
          contentId: info?.contentId,
          contentUrl: info?.contentUrl,
          streamDuration: player.duration || info?.duration || undefined,
          metadata: {
            title: info?.metadata?.title,
            images: (info?.metadata?.images ?? [])
              .filter((i: Sdk) => i?.url)
              .map((i: Sdk) => ({ url: i.url })),
          },
        },
      },
    });
  };

  const syncSession = () => {
    const ctx = context();
    if (!ctx) return;
    const castState = CAST_STATES[ctx.getCastState()] ?? "noDevicesAvailable";
    const session = ctx.getCurrentSession();
    set({
      castState,
      deviceName: session?.getCastDevice?.()?.friendlyName ?? null,
      controlsOpen: castState === "connected" ? snapshot.controlsOpen : false,
    });
    syncMedia();
  };

  const init = () => {
    const { cast, chrome } = env.globals();
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    ctx.addEventListener(
      cast.framework.CastContextEventType.CAST_STATE_CHANGED,
      syncSession,
    );
    ctx.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      syncSession,
    );
    player = new cast.framework.RemotePlayer();
    controller = new cast.framework.RemotePlayerController(player);
    controller.addEventListener(
      cast.framework.RemotePlayerEventType.ANY_CHANGE,
      syncMedia,
    );
    set({ availability: "available", unavailableReason: null });
    syncSession();
  };

  const markUnavailable = (result: Exclude<SdkLoadResult, "available">) => {
    set({
      availability: "unavailable",
      unavailableReason:
        result === "blocked"
          ? "blocked"
          : isSecureContext()
            ? "unsupported"
            : "insecure",
    });
  };

  /**
   * Load and initialise the sender, once. Safe to call from every subscriber.
   *
   * The answer is kept, failure included, so a page full of cast buttons does not inject the
   * script once per button. Only {@link retry} starts over, and only after a `blocked` load.
   */
  const ensureReady = (): Promise<boolean> => {
    if (!ready) {
      ready = env
        .loadSdk()
        .catch((): SdkLoadResult => "blocked")
        .then((result) => {
          if (result !== "available") {
            markUnavailable(result);
            return false;
          }
          try {
            init();
            return true;
          } catch {
            markUnavailable("unsupported");
            return false;
          }
        });
    }
    return ready;
  };

  // -------------------------------------------------------------------------------------------
  // react-native-google-cast's MediaInfo → chrome.cast.media
  // -------------------------------------------------------------------------------------------

  const toMetadata = (md: Sdk) => {
    const media = env.globals().chrome.cast.media;
    const image = env.globals().chrome.cast.Image;
    let out: Sdk;
    switch (md.type) {
      case "movie":
        out = new media.MovieMediaMetadata();
        out.subtitle = md.subtitle;
        break;
      case "tvShow":
        out = new media.TvShowMediaMetadata();
        out.seriesTitle = md.seriesTitle;
        out.season = md.seasonNumber;
        out.episode = md.episodeNumber;
        break;
      case "musicTrack":
        out = new media.MusicTrackMediaMetadata();
        out.artist = md.artist;
        out.albumName = md.albumName;
        break;
      default:
        out = new media.GenericMediaMetadata();
        out.subtitle = md.subtitle;
    }
    out.title = md.title;
    out.images = (md.images ?? [])
      .filter((i: Sdk) => i?.url)
      .map((i: Sdk) => new image(i.url));
    return out;
  };

  const toTrack = (track: Sdk) => {
    const media = env.globals().chrome.cast.media;
    const type =
      track.type === "audio"
        ? media.TrackType.AUDIO
        : track.type === "video"
          ? media.TrackType.VIDEO
          : media.TrackType.TEXT;
    const out = new media.Track(track.id, type);
    out.trackContentId = track.contentId;
    out.trackContentType = track.contentType;
    if (track.subtype) {
      out.subtype = media.TextTrackType[String(track.subtype).toUpperCase()];
    }
    if (track.name) out.name = track.name;
    if (track.language) out.language = track.language;
    return out;
  };

  const toMediaInfo = (info: Sdk) => {
    const media = env.globals().chrome.cast.media;
    const out = new media.MediaInfo(
      info.contentId ?? info.contentUrl,
      info.contentType,
    );
    out.contentUrl = info.contentUrl;
    out.streamType =
      info.streamType === "live"
        ? media.StreamType.LIVE
        : media.StreamType.BUFFERED;
    if (info.streamDuration != null) out.duration = info.streamDuration;
    // The phone SDK's enum values are the web sender's strings ("fmp4", "ts", "mpeg2_ts").
    if (info.hlsSegmentFormat) out.hlsSegmentFormat = info.hlsSegmentFormat;
    if (info.hlsVideoSegmentFormat) {
      out.hlsVideoSegmentFormat = info.hlsVideoSegmentFormat;
    }
    if (info.mediaTracks?.length) out.tracks = info.mediaTracks.map(toTrack);
    if (info.metadata) out.metadata = toMetadata(info.metadata);
    return out;
  };

  const requireSession = () => {
    const session = currentSession();
    if (!session) throw new Error("No cast session");
    return session;
  };

  /** The one `RemoteMediaClient`. Stable, so a hook can hand the same object out on every render. */
  const client = {
    loadMedia: async (request: Sdk): Promise<void> => {
      const session = requireSession();
      const media = env.globals().chrome.cast.media;
      if (request.queueData) {
        const items = request.queueData.items.map((item: Sdk) => {
          const queued = new media.QueueItem(toMediaInfo(item.mediaInfo));
          queued.autoplay = item.autoplay ?? true;
          if (item.preloadTime != null) queued.preloadTime = item.preloadTime;
          return queued;
        });
        const queueRequest = new media.QueueLoadRequest(items);
        queueRequest.startIndex = request.queueData.startIndex ?? 0;
        await new Promise((resolve, reject) =>
          session.getSessionObj().queueLoad(queueRequest, resolve, reject),
        );
        return;
      }
      const load = new media.LoadRequest(toMediaInfo(request.mediaInfo));
      load.autoplay = request.autoplay ?? true;
      if (request.startTime != null) load.currentTime = request.startTime;
      if (request.activeTrackIds) load.activeTrackIds = request.activeTrackIds;
      // Resolves with an error code rather than rejecting, in some SDK versions.
      const error = await session.loadMedia(load);
      if (error) throw new Error(`Cast load failed: ${error}`);
    },
    setActiveTrackIds: async (ids: number[]): Promise<void> => {
      const mediaSession = requireSession().getMediaSession();
      if (!mediaSession) throw new Error("Nothing is loaded on the receiver");
      const media = env.globals().chrome.cast.media;
      await new Promise((resolve, reject) =>
        mediaSession.editTracksInfo(
          new media.EditTracksInfoRequest(ids),
          resolve,
          reject,
        ),
      );
    },
    play: async () => {
      if (player?.isPaused) controller.playOrPause();
    },
    pause: async () => {
      if (player && !player.isPaused) controller.playOrPause();
    },
    seek: async ({ position }: { position: number }) => {
      if (!player) return;
      player.currentTime = position;
      controller.seek();
    },
    stop: async () => {
      controller?.stop();
    },
  };

  /** Open the browser's device picker. */
  const requestSession = async (): Promise<RequestSessionOutcome> => {
    if (!(await ensureReady())) return "unavailable";
    try {
      await context().requestSession();
      return "connected";
    } catch {
      // The sender rejects with "cancel" when the picker is closed, and with other codes for a
      // device that refused. Neither is worth more than the picker already told the user.
      return "cancelled";
    }
  };

  return {
    client,
    ensureReady,
    requestSession,
    getSnapshot: () => snapshot,
    /** Subscribing is what loads the sender, so a page that never shows a cast control never fetches it. */
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      void ensureReady();
      return () => {
        listeners.delete(listener);
      };
    },
    endSession: async (stopCasting = true) => {
      context()?.endCurrentSession?.(stopCasting);
      set({ controlsOpen: false });
    },
    setControlsOpen: (open: boolean) => set({ controlsOpen: open }),
    /** Open the dialog that says why casting cannot start. */
    showUnavailable: () => set({ unavailableOpen: true }),
    dismissUnavailable: () => set({ unavailableOpen: false }),
    /**
     * Try again from the dialog. A `blocked` load starts over; any other reason is a fixed property
     * of this page and browser, so asking again just reopens the same answer.
     */
    retry: async (): Promise<RequestSessionOutcome> => {
      set({ unavailableOpen: false });
      if (snapshot.unavailableReason === "blocked") ready = null;
      const outcome = await requestSession();
      if (outcome === "unavailable") set({ unavailableOpen: true });
      return outcome;
    },
  };
}

export type WebCastSession = ReturnType<typeof createWebCastSession>;

/** The page's one cast session. */
export const webCastSession = createWebCastSession();
