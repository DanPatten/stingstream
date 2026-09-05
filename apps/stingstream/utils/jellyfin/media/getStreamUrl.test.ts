import { describe, expect, mock, test } from "bun:test";
import { stubReactNative } from "@/test-utils/reactNative";

stubReactNative();
mock.module("expo", () => ({
  // codecSupport probes the native MPV module; under bun:test there is none.
  requireOptionalNativeModule: () => null,
}));

const { getStreamUrl, getDownloadStreamUrl } = await import("./getStreamUrl");
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
