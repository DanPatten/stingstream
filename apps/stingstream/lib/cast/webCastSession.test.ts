import { describe, expect, test } from "bun:test";
import { createWebCastSession } from "./webCastSession";

/**
 * A stand-in for `cast.framework` and `chrome.cast`, recording what the session store builds.
 *
 * Just enough of Google's sender to drive the store: constructors that keep whatever is assigned to
 * them, a context whose cast state the test sets, and a remote player whose change event it fires.
 */
function fakeSdk() {
  const contextListeners: Record<string, (() => void)[]> = {};
  const playerListeners: (() => void)[] = [];
  const loads: any[] = [];
  const trackEdits: number[][] = [];
  const calls: string[] = [];

  const media = {
    currentItemId: 7,
    editTracksInfo: (req: any, ok: () => void) => {
      trackEdits.push(req.activeTrackIds);
      ok();
    },
  };
  const session = {
    getCastDevice: () => ({ friendlyName: "Living room" }),
    getMediaSession: () => media,
    loadMedia: async (req: any) => {
      loads.push(req);
      return undefined;
    },
    getSessionObj: () => ({
      queueLoad: (req: any, ok: () => void) => {
        loads.push(req);
        ok();
      },
    }),
  };

  const state = {
    castState: "NOT_CONNECTED",
    session: null as typeof session | null,
    requestSession: async () => {
      state.castState = "CONNECTED";
      state.session = session;
      fire("SESSION_STATE_CHANGED");
    },
  };
  const fire = (type: string) => {
    for (const l of contextListeners[type] ?? []) l();
  };

  const context = {
    setOptions: (o: any) => calls.push(`setOptions:${o.receiverApplicationId}`),
    addEventListener: (type: string, l: () => void) => {
      contextListeners[type] ??= [];
      contextListeners[type].push(l);
    },
    getCastState: () => state.castState,
    getCurrentSession: () => state.session,
    requestSession: () => state.requestSession(),
    endCurrentSession: (stop: boolean) => {
      calls.push(`end:${stop}`);
      state.castState = "NOT_CONNECTED";
      state.session = null;
      fire("SESSION_STATE_CHANGED");
    },
  };

  const player: any = {
    isConnected: false,
    isMediaLoaded: false,
    isPaused: false,
    currentTime: 0,
    duration: 0,
    playerState: "IDLE",
    mediaInfo: null,
  };

  /** A constructor whose instances keep their constructor arguments for inspection. */
  const keep = (name: string) =>
    function (this: any, ...args: any[]) {
      this.__type = name;
      this.__args = args;
    } as any;

  const cast = {
    framework: {
      CastContext: { getInstance: () => context },
      CastContextEventType: {
        CAST_STATE_CHANGED: "CAST_STATE_CHANGED",
        SESSION_STATE_CHANGED: "SESSION_STATE_CHANGED",
      },
      // Both are called with `new`, which an arrow function cannot be: these stay function
      // expressions, whatever the linter would prefer.
      // biome-ignore lint/complexity/useArrowFunction: constructed with `new`
      RemotePlayer: function () {
        return player;
      } as any,
      // biome-ignore lint/complexity/useArrowFunction: constructed with `new`
      RemotePlayerController: function () {
        return {
          addEventListener: (_t: string, l: () => void) =>
            playerListeners.push(l),
          playOrPause: () => {
            calls.push("playOrPause");
          },
          seek: () => calls.push(`seek:${player.currentTime}`),
          stop: () => calls.push("stop"),
        };
      } as any,
      RemotePlayerEventType: { ANY_CHANGE: "anyChanged" },
    },
  };

  const chrome = {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: "origin_scoped" },
      Image: function (this: any, url: string) {
        this.url = url;
      } as any,
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
        StreamType: { BUFFERED: "BUFFERED", LIVE: "LIVE" },
        TrackType: { TEXT: "TEXT", AUDIO: "AUDIO", VIDEO: "VIDEO" },
        TextTrackType: { SUBTITLES: "SUBTITLES", CAPTIONS: "CAPTIONS" },
        MediaInfo: function (
          this: any,
          contentId: string,
          contentType: string,
        ) {
          this.contentId = contentId;
          this.contentType = contentType;
        } as any,
        Track: function (this: any, trackId: number, type: string) {
          this.trackId = trackId;
          this.type = type;
        } as any,
        LoadRequest: function (this: any, mediaInfo: any) {
          this.media = mediaInfo;
        } as any,
        QueueItem: function (this: any, mediaInfo: any) {
          this.media = mediaInfo;
        } as any,
        QueueLoadRequest: function (this: any, items: any[]) {
          this.items = items;
        } as any,
        EditTracksInfoRequest: function (this: any, ids: number[]) {
          this.activeTrackIds = ids;
        } as any,
        MovieMediaMetadata: keep("movie"),
        TvShowMediaMetadata: keep("tvShow"),
        MusicTrackMediaMetadata: keep("musicTrack"),
        GenericMediaMetadata: keep("generic"),
      },
    },
  };

  return {
    env: {
      loadSdk: async () => "available" as const,
      globals: () => ({ cast, chrome }),
    },
    state,
    player,
    loads,
    trackEdits,
    calls,
    fireContext: fire,
    firePlayer: () => {
      for (const l of playerListeners) l();
    },
  };
}

describe("webCastSession", () => {
  test("a browser that cannot cast, on a secure page, is unsupported", async () => {
    const store = createWebCastSession({
      loadSdk: async () => "unsupported",
      globals: () => ({}),
      isSecureContext: () => true,
    });
    expect(store.getSnapshot().availability).toBe("unknown");
    expect(await store.requestSession()).toBe("unavailable");
    expect(store.getSnapshot().availability).toBe("unavailable");
    expect(store.getSnapshot().unavailableReason).toBe("unsupported");
  });

  test("an insecure page is blamed before the browser: the address is the fix", async () => {
    const store = createWebCastSession({
      loadSdk: async () => "unsupported",
      globals: () => ({}),
      isSecureContext: () => false,
    });
    await store.ensureReady();
    expect(store.getSnapshot().unavailableReason).toBe("insecure");
  });

  test("a script that never arrives is blocked, even on an insecure page", async () => {
    const store = createWebCastSession({
      loadSdk: async () => "blocked",
      globals: () => ({}),
      isSecureContext: () => false,
    });
    await store.ensureReady();
    expect(store.getSnapshot().unavailableReason).toBe("blocked");
  });

  test("a sender that throws while loading is blocked, not a crash", async () => {
    const store = createWebCastSession({
      loadSdk: async () => {
        throw new Error("network");
      },
      globals: () => ({}),
    });
    expect(await store.ensureReady()).toBe(false);
    expect(store.getSnapshot().availability).toBe("unavailable");
    expect(store.getSnapshot().unavailableReason).toBe("blocked");
  });

  test("the answer is kept, so many buttons load the script once", async () => {
    let loads = 0;
    const store = createWebCastSession({
      loadSdk: async () => {
        loads++;
        return "unsupported";
      },
      globals: () => ({}),
    });
    store.subscribe(() => {});
    store.subscribe(() => {});
    await store.requestSession();
    await store.requestSession();
    expect(loads).toBe(1);
  });

  test("Try again reloads only after a blocked load, and reopens the dialog if it still fails", async () => {
    const sdk = fakeSdk();
    let attempt = 0;
    const store = createWebCastSession({
      ...sdk.env,
      loadSdk: async () => (++attempt === 1 ? "blocked" : "available"),
    });
    await store.ensureReady();
    store.showUnavailable();
    expect(store.getSnapshot().unavailableOpen).toBe(true);

    expect(await store.retry()).toBe("connected");
    expect(attempt).toBe(2);
    expect(store.getSnapshot().unavailableOpen).toBe(false);
    expect(store.getSnapshot().availability).toBe("available");
    expect(store.getSnapshot().unavailableReason).toBeNull();

    let unsupportedLoads = 0;
    const stuck = createWebCastSession({
      loadSdk: async () => {
        unsupportedLoads++;
        return "unsupported";
      },
      globals: () => ({}),
      isSecureContext: () => true,
    });
    await stuck.ensureReady();
    expect(await stuck.retry()).toBe("unavailable");
    expect(unsupportedLoads).toBe(1);
    expect(stuck.getSnapshot().unavailableOpen).toBe(true);
  });

  test("initialises the default receiver and follows the session", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().castState));
    await store.ensureReady();

    expect(sdk.calls).toContain("setOptions:CC1AD845");
    expect(store.getSnapshot().availability).toBe("available");
    expect(store.getSnapshot().castState).toBe("notConnected");

    expect(await store.requestSession()).toBe("connected");
    expect(store.getSnapshot().castState).toBe("connected");
    expect(store.getSnapshot().deviceName).toBe("Living room");
    expect(seen).toContain("connected");

    store.setControlsOpen(true);
    await store.endSession();
    expect(sdk.calls).toContain("end:true");
    expect(store.getSnapshot().castState).toBe("notConnected");
    expect(store.getSnapshot().deviceName).toBeNull();
    expect(store.getSnapshot().controlsOpen).toBe(false);
  });

  test("a closed picker is a cancel, not an error", async () => {
    const sdk = fakeSdk();
    sdk.state.requestSession = async () => {
      throw "cancel";
    };
    const store = createWebCastSession(sdk.env);
    expect(await store.requestSession()).toBe("cancelled");
  });

  test("maps an HLS film with a subtitle track onto chrome.cast.media", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    await store.requestSession();

    await store.client.loadMedia({
      mediaInfo: {
        contentId: "item-1",
        contentUrl:
          "https://media.example.com/master.m3u8?SegmentContainer=mp4",
        contentType: "application/x-mpegURL",
        hlsSegmentFormat: "fmp4",
        hlsVideoSegmentFormat: "fmp4",
        streamType: "buffered",
        streamDuration: 5400,
        mediaTracks: [
          {
            id: 3,
            type: "text",
            subtype: "subtitles",
            contentId: "https://media.example.com/sub.vtt?api_key=k",
            contentType: "text/vtt",
            language: "eng",
            name: "English",
          },
        ],
        metadata: {
          type: "movie",
          title: "Caminandes",
          subtitle: "A llama",
          images: [{ url: "https://media.example.com/poster.jpg" }],
        },
      },
      startTime: 90,
    });

    const [load] = sdk.loads;
    expect(load.currentTime).toBe(90);
    expect(load.autoplay).toBe(true);
    const info = load.media;
    expect(info.contentId).toBe("item-1");
    expect(info.contentUrl).toContain("master.m3u8");
    expect(info.contentType).toBe("application/x-mpegURL");
    expect(info.hlsSegmentFormat).toBe("fmp4");
    expect(info.hlsVideoSegmentFormat).toBe("fmp4");
    expect(info.streamType).toBe("BUFFERED");
    expect(info.duration).toBe(5400);
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]).toMatchObject({
      trackId: 3,
      type: "TEXT",
      subtype: "SUBTITLES",
      trackContentType: "text/vtt",
      language: "eng",
      name: "English",
    });
    expect(info.metadata.__type).toBe("movie");
    expect(info.metadata.title).toBe("Caminandes");
    expect(info.metadata.images.map((i: any) => i.url)).toEqual([
      "https://media.example.com/poster.jpg",
    ]);
  });

  test("an episode carries its series, season and episode numbers", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    await store.requestSession();
    await store.client.loadMedia({
      mediaInfo: {
        contentId: "ep",
        contentUrl: "https://media.example.com/ep.mp4",
        contentType: "video/mp4",
        metadata: {
          type: "tvShow",
          title: "Pilot",
          seriesTitle: "Show",
          seasonNumber: 1,
          episodeNumber: 2,
        },
      },
    });
    const md = sdk.loads[0].media.metadata;
    expect(md.__type).toBe("tvShow");
    expect(md).toMatchObject({ seriesTitle: "Show", season: 1, episode: 2 });
  });

  test("a music queue goes through queueLoad with its start index", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    await store.requestSession();
    await store.client.loadMedia({
      queueData: {
        items: [
          {
            mediaInfo: {
              contentId: "a",
              contentUrl: "https://m/a.mp3",
              contentType: "audio/mpeg",
            },
            preloadTime: 10,
          },
          {
            mediaInfo: {
              contentId: "b",
              contentUrl: "https://m/b.mp3",
              contentType: "audio/mpeg",
            },
          },
        ],
        startIndex: 1,
      },
    });
    const [queue] = sdk.loads;
    expect(queue.items).toHaveLength(2);
    expect(queue.startIndex).toBe(1);
    expect(queue.items[0].preloadTime).toBe(10);
    expect(queue.items[1].autoplay).toBe(true);
  });

  test("loading with no session throws, so the caller's error path runs", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    await store.ensureReady();
    await expect(
      store.client.loadMedia({ mediaInfo: { contentUrl: "x" } }),
    ).rejects.toThrow("No cast session");
  });

  test("reports what the receiver is playing, and controls it", async () => {
    const sdk = fakeSdk();
    const store = createWebCastSession(sdk.env);
    await store.requestSession();
    expect(store.getSnapshot().mediaStatus).toBeNull();

    Object.assign(sdk.player, {
      isConnected: true,
      isMediaLoaded: true,
      isPaused: false,
      currentTime: 42,
      duration: 100,
      playerState: "PLAYING",
      mediaInfo: {
        contentId: "item-1",
        metadata: { title: "Caminandes", images: [{ url: "https://p" }] },
      },
    });
    sdk.firePlayer();

    const status = store.getSnapshot().mediaStatus!;
    expect(status.currentItemId).toBe(7);
    expect(status.playerState).toBe("playing");
    expect(status.streamPosition).toBe(42);
    expect(status.mediaInfo?.streamDuration).toBe(100);
    expect(status.mediaInfo?.metadata?.title).toBe("Caminandes");

    await store.client.play(); // already playing: nothing to toggle
    await store.client.pause();
    await store.client.seek({ position: 60 });
    await store.client.setActiveTrackIds([3]);
    expect(sdk.calls.filter((c) => c === "playOrPause")).toHaveLength(1);
    expect(sdk.calls).toContain("seek:60");
    expect(sdk.trackEdits).toEqual([[3]]);

    sdk.player.isMediaLoaded = false;
    sdk.firePlayer();
    expect(store.getSnapshot().mediaStatus).toBeNull();
  });
});
