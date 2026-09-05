import { describe, expect, mock, test } from "bun:test";
import { stubReactNative } from "@/test-utils/reactNative";

stubReactNative();
mock.module("expo", () => ({
  // codecSupport probes the native MPV module; under bun:test there is none.
  requireOptionalNativeModule: () => null,
}));

const {
  getStreamUrl,
  getDownloadStreamUrl,
  wantsTranscodedDownload,
  TRANSCODE_READ_TIMEOUT_SECONDS,
} = await import("./getStreamUrl");
const { makeApi, bodyContaining } = await import("@/test-utils/jellyfinApi");

describe("getStreamUrl", () => {
  test("direct play URL carries the source container and the ApiKey", async () => {
    const api = makeApi();
    api.mock
      .onPost("https://jellyfin.example.com/Items/item-1/PlaybackInfo")
      .reply(200, {
        PlaySessionId: "session-1",
        MediaSources: [{ Id: "media-1", Container: "mkv" }],
      });

    const result = await getStreamUrl({
      api,
      item: { Id: "item-1", Type: "Movie" },
      userId: "user-1",
      startTimeTicks: 0,
      deviceProfile: {},
    });

    const url = new URL(result!.url!);
    expect(url.searchParams.get("container")).toBe("mkv");
    expect(url.searchParams.get("ApiKey")).toBe("SECRET_TOKEN");
  });
});

describe("getDownloadStreamUrl", () => {
  const MAX = { key: "Max", value: undefined };
  const LIMITED = { key: "4mbps", value: 4_000_000 };

  const download = async (
    api: ReturnType<typeof makeApi>,
    quality: { key: string; value: number | undefined },
  ) => {
    const result = await getDownloadStreamUrl({
      api,
      item: { Id: "item-1", Type: "Movie" },
      userId: "user-1",
      mediaSourceId: "media-1",
      maxStreamingBitrate: quality.value,
      audioStreamIndex: 0,
      subtitleStreamIndex: 0,
    });
    return new URL(result!.url!);
  };

  test("returns null when the server offers no media source", async () => {
    const api = makeApi();
    api.mock
      .onPost(
        "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
        bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
      )
      .reply(200, { PlaySessionId: "session-1", MediaSources: [] });

    const result = await getDownloadStreamUrl({
      api,
      item: { Id: "item-1", Type: "Movie" },
      userId: "user-1",
      audioStreamIndex: 0,
      subtitleStreamIndex: -1,
    });

    expect(result).toBeNull();
  });

  describe("the server says the player can play the original (no TranscodingUrl)", () => {
    const playerCanPlayTheOriginal = {
      PlaySessionId: "session-1",
      MediaSources: [{ Id: "media-1" }],
    };

    test("downloads the original file when the user picks Max quality", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, playerCanPlayTheOriginal);

      const url = await download(api, MAX);

      expect(url.pathname).toBe("/Items/media-1/Download");
    });

    test("downloads the original file when the source already fits under the user's limited quality", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({
            deviceProfile: { Name: "1. MPV Download" },
            maxStreamingBitrate: 4_000_000,
          }),
        )
        .reply(200, playerCanPlayTheOriginal);

      const url = await download(api, LIMITED);

      expect(url.pathname).toBe("/Items/media-1/Download");
    });

    test("imposes no bitrate cap of its own when the user picks Max quality", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, playerCanPlayTheOriginal);

      await download(api, MAX);

      const negotiatedCaps = api.mock.history.post.map((request) => {
        const profile = JSON.parse(request.data).deviceProfile;
        return {
          MaxStreamingBitrate: profile.MaxStreamingBitrate,
          MaxStaticBitrate: profile.MaxStaticBitrate,
        };
      });
      expect(negotiatedCaps).toEqual([
        { MaxStreamingBitrate: 999_999_999, MaxStaticBitrate: 999_999_999 },
      ]);
    });

    test("authenticates the URL with the ApiKey query parameter", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, playerCanPlayTheOriginal);

      const url = await download(api, MAX);

      expect(url.searchParams.get("ApiKey")).toBe("SECRET_TOKEN");
    });
  });

  describe("the server says the original needs transcoding (TranscodingUrl present)", () => {
    const downloadGetsAProgressiveMp4 = {
      PlaySessionId: "session-1",
      MediaSources: [
        {
          Id: "media-1",
          TranscodingUrl:
            "/videos/media-1/stream.mp4?DeviceId=device-1&PlaySessionId=session-1",
        },
      ],
    };

    test("downloads the progressive mp4 when the source exceeds the user's limited quality", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({
            deviceProfile: { Name: "1. MPV Download" },
            maxStreamingBitrate: 4_000_000,
          }),
        )
        .reply(200, downloadGetsAProgressiveMp4);

      const url = await download(api, LIMITED);

      expect(url.href).toBe(
        "https://jellyfin.example.com/videos/media-1/stream.mp4?DeviceId=device-1&PlaySessionId=session-1",
      );
    });

    test("a transcode waits far longer than the sixty seconds that killed M5's download", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, downloadGetsAProgressiveMp4);

      const result = await getDownloadStreamUrl({
        api,
        item: { Id: "item-1", Type: "Movie" },
        userId: "user-1",
        mediaSourceId: "media-1",
        maxStreamingBitrate: 4_000_000,
        audioStreamIndex: 0,
        subtitleStreamIndex: 0,
      });

      expect(result?.transcoded).toBe(true);
      expect(result?.readTimeoutSeconds).toBe(TRANSCODE_READ_TIMEOUT_SECONDS);
    });

    test("downloads the TranscodingUrl exactly as the server sent it, even when the user picks no subtitle (streaming rewrites SubtitleMethod, downloads must not)", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, {
          PlaySessionId: "session-1",
          MediaSources: [
            {
              Id: "media-1",
              TranscodingUrl:
                "/videos/media-1/stream.mp4?DeviceId=device-1&SubtitleMethod=Encode&PlaySessionId=session-1",
            },
          ],
        });

      const result = await getDownloadStreamUrl({
        api,
        item: { Id: "item-1", Type: "Movie" },
        userId: "user-1",
        mediaSourceId: "media-1",
        audioStreamIndex: 0,
        subtitleStreamIndex: -1,
      });

      expect(result?.url).toBe(
        "https://jellyfin.example.com/videos/media-1/stream.mp4?DeviceId=device-1&SubtitleMethod=Encode&PlaySessionId=session-1",
      );
    });

    test("downloads the progressive mp4 even when the user picks Max quality (transcode forced by burn-in, codecs or server policy)", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, downloadGetsAProgressiveMp4);

      const url = await download(api, MAX);

      expect(url.href).toBe(
        "https://jellyfin.example.com/videos/media-1/stream.mp4?DeviceId=device-1&PlaySessionId=session-1",
      );
    });
  });

  /**
   * Dan's decision, carried from M5 into M7 (`docs/APP-RELEASE.md` §6): a download takes the
   * original unless the person doing the downloading asked for something else. PlaybackInfo
   * setting `TranscodingUrl` is the *server* saying the download profile cannot direct-play the
   * source, which is a different statement and must not be read as consent to re-encode.
   */
  describe("what counts as asking for a transcode", () => {
    test("the default download quality, with no bitrate cap, does not", () => {
      expect(wantsTranscodedDownload("original", undefined)).toBe(false);
      expect(wantsTranscodedDownload(undefined, undefined)).toBe(false);
    });

    test("a download quality other than original does", () => {
      expect(wantsTranscodedDownload("high", undefined)).toBe(true);
      expect(wantsTranscodedDownload("low", undefined)).toBe(true);
    });

    test("a bitrate cap does, because it cannot be honoured any other way", () => {
      expect(wantsTranscodedDownload("original", 4_000_000)).toBe(true);
    });

    test("Max quality is not a cap", () => {
      // BITRATES[0] is `{ key: "Max", value: undefined }` -- the quality picker's way of saying
      // "whatever the source is", which is the same answer as not asking at all.
      expect(wantsTranscodedDownload("original", undefined)).toBe(false);
    });
  });

  describe("a federated source the server wants to transcode (the M5 4K failure)", () => {
    // The exact shape M5 hit: a 4K federated source the download profile cannot direct-play, so
    // PlaybackInfo returns both a mesh `Path` and a `TranscodingUrl`. The old guard
    // (`!mediaSource.TranscodingUrl`) skipped the mesh branch entirely, and the download became a
    // home-node transcode of bytes pulled over the mesh -- which timed out at sixty seconds.
    const fourKFederated = {
      PlaySessionId: "session-1",
      MediaSources: [
        {
          Id: "media-1",
          IsRemote: true,
          Protocol: "Http",
          Path: "https://stingstream.local/stream/g1/movie:tmdb:1/holder",
          TranscodingUrl:
            "/videos/media-1/stream.mp4?DeviceId=device-1&TranscodeReasons=DirectPlayError",
        },
      ],
    };

    const playbackInfoReturns = (
      api: ReturnType<typeof makeApi>,
      body: unknown,
    ) =>
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, body);

    // `fetchItemSources` swallows every failure and falls back to PlaybackInfo's own path, which
    // is what these assertions are about; a rejecting fetch is the shortest way to say "no node
    // answered".
    const withNoSourcesEndpoint = async <T>(
      run: () => Promise<T>,
    ): Promise<T> => {
      const original = globalThis.fetch;
      globalThis.fetch = mock(() =>
        Promise.reject(new Error("no node")),
      ) as unknown as typeof fetch;
      try {
        return await run();
      } finally {
        globalThis.fetch = original;
      }
    };

    test("downloads the original over the mesh, TranscodingUrl and all", async () => {
      const api = makeApi();
      playbackInfoReturns(api, fourKFederated);

      const result = await withNoSourcesEndpoint(() =>
        getDownloadStreamUrl({
          api,
          item: { Id: "item-1", Type: "Movie" },
          userId: "user-1",
          mediaSourceId: "media-1",
          audioStreamIndex: 0,
          subtitleStreamIndex: 0,
        }),
      );

      expect(result?.url).toBe(
        "https://stingstream.local/stream/g1/movie:tmdb:1/holder",
      );
      expect(result?.transcoded).toBe(false);
      expect(result?.readTimeoutSeconds).toBeUndefined();
    });

    test("takes the transcode when the user picked a download quality, and waits for it", async () => {
      const api = makeApi();
      playbackInfoReturns(api, fourKFederated);

      const result = await withNoSourcesEndpoint(() =>
        getDownloadStreamUrl({
          api,
          item: { Id: "item-1", Type: "Movie" },
          userId: "user-1",
          mediaSourceId: "media-1",
          audioStreamIndex: 0,
          subtitleStreamIndex: 0,
          downloadQuality: "low",
        }),
      );

      expect(result?.url).toBe(
        "https://jellyfin.example.com/videos/media-1/stream.mp4?DeviceId=device-1&TranscodeReasons=DirectPlayError",
      );
      expect(result?.transcoded).toBe(true);
      expect(result?.readTimeoutSeconds).toBe(TRANSCODE_READ_TIMEOUT_SECONDS);
      expect(TRANSCODE_READ_TIMEOUT_SECONDS).toBeGreaterThan(60);
    });

    test("a requested quality the source already satisfies still takes the mesh original", async () => {
      const api = makeApi();
      playbackInfoReturns(api, {
        PlaySessionId: "session-1",
        MediaSources: [
          {
            Id: "media-1",
            IsRemote: true,
            Protocol: "Http",
            Path: "https://stingstream.local/stream/g1/movie:tmdb:1/holder",
          },
        ],
      });

      const result = await withNoSourcesEndpoint(() =>
        getDownloadStreamUrl({
          api,
          item: { Id: "item-1", Type: "Movie" },
          userId: "user-1",
          mediaSourceId: "media-1",
          audioStreamIndex: 0,
          subtitleStreamIndex: 0,
          downloadQuality: "high",
        }),
      );

      // No TranscodingUrl means the server is saying the original already fits. Downloading it
      // through `/Items/{id}/Download` would make the home node fetch it over the mesh and
      // re-serve it, which is the double hop the mesh path exists to avoid.
      expect(result?.url).toBe(
        "https://stingstream.local/stream/g1/movie:tmdb:1/holder",
      );
      expect(result?.transcoded).toBe(false);
    });
  });

  describe("a federated item (IsRemote, Protocol Http, no TranscodingUrl)", () => {
    // `fetchItemSources`/`bestOnlineSource` (lib/stingstream/sources.ts) call the global `fetch`
    // directly rather than the axios instance `api.mock` stubs, since StingStream.Core's own API
    // is not part of the Jellyfin SDK's request pipeline. `rewriteStreamUrlForMesh` never rewrites
    // in this test environment (no MeshProvider mounted, so the module's rewrite context stays its
    // "not running" default) — every assertion below is therefore on the untouched URL string.
    const federatedMediaSource = {
      Id: "media-1",
      IsRemote: true,
      Protocol: "Http",
      Path: "https://stingstream.local/stream/g1/movie:tmdb:1/holder-from-playbackinfo",
    };

    const withStubbedFetch = async (
      handler: (url: string) => Response | null,
      run: () => Promise<unknown>,
    ) => {
      const original = globalThis.fetch;
      globalThis.fetch = mock((url: string) => {
        const res = handler(String(url));
        if (!res) return Promise.reject(new Error(`unexpected fetch: ${url}`));
        return Promise.resolve(res);
      }) as unknown as typeof fetch;
      try {
        return await run();
      } finally {
        globalThis.fetch = original;
      }
    };

    test("downloads from the best-scored online source, not just whatever PlaybackInfo returned", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, {
          PlaySessionId: "session-1",
          MediaSources: [federatedMediaSource],
        });

      const result = await withStubbedFetch(
        (url) =>
          url ===
          "https://jellyfin.example.com/stingstream/api/v1/items/item-1/sources"
            ? new Response(
                JSON.stringify({
                  ItemKey: "movie:tmdb:1",
                  Policy: "speed_first",
                  HeldLocally: false,
                  Sources: [
                    {
                      Node: "offline-but-top-scored",
                      Online: false,
                      StreamUrl:
                        "https://stingstream.local/stream/g1/movie:tmdb:1/offline-but-top-scored",
                    },
                    {
                      Node: "best-online",
                      Online: true,
                      StreamUrl:
                        "https://stingstream.local/stream/g1/movie:tmdb:1/best-online",
                    },
                  ],
                }),
                { status: 200 },
              )
            : null,
        () =>
          getDownloadStreamUrl({
            api,
            item: { Id: "item-1", Type: "Movie" },
            userId: "user-1",
            mediaSourceId: "media-1",
            audioStreamIndex: 0,
            subtitleStreamIndex: 0,
          }),
      );

      expect((result as { url: string }).url).toBe(
        "https://stingstream.local/stream/g1/movie:tmdb:1/best-online",
      );
    });

    test("falls back to PlaybackInfo's own source when /items/{id}/sources is unreachable", async () => {
      const api = makeApi();
      api.mock
        .onPost(
          "https://jellyfin.example.com/Items/item-1/PlaybackInfo",
          bodyContaining({ deviceProfile: { Name: "1. MPV Download" } }),
        )
        .reply(200, {
          PlaySessionId: "session-1",
          MediaSources: [federatedMediaSource],
        });

      const result = await withStubbedFetch(
        (url) =>
          url ===
          "https://jellyfin.example.com/stingstream/api/v1/items/item-1/sources"
            ? new Response("", { status: 503 })
            : null,
        () =>
          getDownloadStreamUrl({
            api,
            item: { Id: "item-1", Type: "Movie" },
            userId: "user-1",
            mediaSourceId: "media-1",
            audioStreamIndex: 0,
            subtitleStreamIndex: 0,
          }),
      );

      expect((result as { url: string }).url).toBe(federatedMediaSource.Path);
    });
  });
});
