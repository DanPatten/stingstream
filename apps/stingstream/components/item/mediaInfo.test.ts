import { describe, expect, test } from "bun:test";
import type {
  BaseItemDto,
  MediaSourceInfo,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildItemInfo,
  formatBitrateOrNull,
  formatChannels,
  formatCodecLevel,
  formatFileSize,
  formatFrameRate,
  formatSampleRate,
  formatVideoRange,
  type Translate,
} from "./mediaInfo";

// The key and its arguments, so a test can see which string a row asked for.
const t: Translate = (key, args) =>
  args ? `${key} ${JSON.stringify(args)}` : key;

const TICKS_PER_SECOND = 10_000_000;

const stream = (s: Partial<MediaStream>): MediaStream => s as MediaStream;

const source = (s: Partial<MediaSourceInfo>): MediaSourceInfo =>
  ({ Id: "src-1", ...s }) as MediaSourceInfo;

const movie = (item: Partial<BaseItemDto>): BaseItemDto =>
  ({ Id: "m1", Type: "Movie", Name: "Nosferatu", ...item }) as BaseItemDto;

describe("formatters", () => {
  test("file sizes in binary steps", () => {
    expect(formatFileSize(0)).toBeNull();
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(4.2 * 1024 ** 3)).toBe("4.2 GB");
    expect(formatFileSize(734 * 1024 ** 2)).toBe("734 MB");
  });

  test("a missing bitrate is nothing, not N/A", () => {
    expect(formatBitrateOrNull(undefined)).toBeNull();
    expect(formatBitrateOrNull(0)).toBeNull();
    expect(formatBitrateOrNull(5_430_000)).toBe("5.43 Mbps");
  });

  test("frame rates keep their fraction and lose their zeros", () => {
    expect(formatFrameRate(23.976023)).toBe("23.976 fps");
    expect(formatFrameRate(24)).toBe("24 fps");
    expect(formatFrameRate(59.94)).toBe("59.94 fps");
    expect(formatFrameRate(0)).toBeNull();
    expect(formatFrameRate(Number.NaN)).toBeNull();
  });

  test("sample rates in kHz", () => {
    expect(formatSampleRate(48000)).toBe("48 kHz");
    expect(formatSampleRate(44100)).toBe("44.1 kHz");
    expect(formatSampleRate(null)).toBeNull();
  });

  test("codec levels as each codec writes them", () => {
    expect(formatCodecLevel("h264", 41)).toBe("4.1");
    expect(formatCodecLevel("hevc", 153)).toBe("5.1");
    expect(formatCodecLevel("hevc", 150)).toBe("5");
    expect(formatCodecLevel("av1", 8)).toBe("8");
    expect(formatCodecLevel("h264", 0)).toBeNull();
    expect(formatCodecLevel("h264", undefined)).toBeNull();
  });

  test("channels with their layout", () => {
    expect(formatChannels(6, "5.1")).toBe("6 (5.1)");
    expect(formatChannels(2, null)).toBe("2");
    expect(formatChannels(null, "stereo")).toBe("stereo");
    expect(formatChannels(null, null)).toBeNull();
  });

  test("video range", () => {
    expect(formatVideoRange(stream({ VideoRangeType: "DOVIWithHDR10" }))).toBe(
      "Dolby Vision",
    );
    expect(
      formatVideoRange(stream({ VideoRange: "HDR", VideoRangeType: "HDR10" })),
    ).toBe("HDR10");
    expect(formatVideoRange(stream({ VideoRange: "SDR" }))).toBe("SDR");
    expect(formatVideoRange(stream({ VideoRange: "Unknown" }))).toBeNull();
  });
});

describe("buildItemInfo", () => {
  const full = movie({
    ProductionYear: 1922,
    RunTimeTicks: 5652 * TICKS_PER_SECOND,
    DateCreated: "2026-09-01T12:00:00Z",
    ProviderIds: { Tmdb: "653", Imdb: "tt0013442" },
    MediaSources: [
      source({
        Path: "/media/movies/Nosferatu (1922)/Nosferatu.mkv",
        Size: 4.2 * 1024 ** 3,
        RunTimeTicks: 5652 * TICKS_PER_SECOND,
        Container: "mkv",
        Bitrate: 6_000_000,
        MediaStreams: [
          stream({
            Type: "Video",
            Index: 0,
            Codec: "h264",
            Profile: "High",
            Level: 41,
            Width: 1920,
            Height: 1080,
            BitDepth: 8,
            RealFrameRate: 23.976,
            VideoRange: "SDR",
          }),
          stream({
            Type: "Audio",
            Index: 1,
            Codec: "ac3",
            Language: "eng",
            Channels: 6,
            ChannelLayout: "5.1",
            SampleRate: 48000,
            IsDefault: true,
          }),
          stream({
            Type: "Subtitle",
            Index: 2,
            Codec: "subrip",
            Language: "eng",
            IsExternal: true,
            Path: "/media/movies/Nosferatu (1922)/Nosferatu.en.srt",
          }),
        ],
      }),
    ],
  });

  const values = (info: ReturnType<typeof buildItemInfo>) =>
    Object.fromEntries(
      info.versions
        .flatMap((version) => version.sections)
        .flatMap((section) =>
          section.rows.map((row) => [`${section.key}.${row.key}`, row.value]),
        ),
    );

  test("an administrator sees the file, every stream and the paths", () => {
    const info = buildItemInfo(full, { t, isAdmin: true });

    expect(info.general?.rows.map((row) => row.key)).toEqual([
      "year",
      "runtime",
      "added",
      "tmdb",
      "imdb",
    ]);
    expect(info.versions).toHaveLength(1);
    expect(info.versions[0].title).toBeUndefined();
    expect(info.versions[0].sections.map((section) => section.key)).toEqual([
      "file",
      "video-0",
      "audio-1",
      "subtitle-2",
    ]);

    const v = values(info);
    expect(v["file.path"]).toBe("/media/movies/Nosferatu (1922)/Nosferatu.mkv");
    expect(v["file.size"]).toBe("4.2 GB");
    expect(v["file.duration"]).toBe("1:34:12");
    expect(v["file.container"]).toBe("MKV");
    expect(v["video-0.codec"]).toBe("H264");
    expect(v["video-0.level"]).toBe("4.1");
    expect(v["video-0.resolution"]).toBe("1920×1080");
    expect(v["video-0.frame_rate"]).toBe("23.976 fps");
    expect(v["audio-1.channels"]).toBe("6 (5.1)");
    expect(v["audio-1.default"]).toBe("item_info.yes");
    expect(v["audio-1.forced"]).toBeUndefined();
    expect(v["subtitle-2.location"]).toBe("item_info.external");
    expect(v["subtitle-2.path"]).toContain("Nosferatu.en.srt");

    const path = info.versions[0].sections[0].rows.find(
      (row) => row.key === "path",
    );
    expect(path?.copyable).toBe(true);
  });

  test("a member never sees a server path", () => {
    const v = values(buildItemInfo(full, { t, isAdmin: false }));
    expect(v["file.path"]).toBeUndefined();
    expect(v["subtitle-2.path"]).toBeUndefined();
    expect(v["file.size"]).toBe("4.2 GB");
  });

  test("a title with no media source shows what is known and no empty sections", () => {
    const info = buildItemInfo(
      movie({ ProductionYear: 1922, MediaSources: [] }),
      { t, isAdmin: true },
    );
    expect(info.general?.rows.map((row) => row.key)).toEqual(["year"]);
    expect(info.versions).toEqual([]);

    const bare = buildItemInfo(movie({}), { t, isAdmin: true });
    expect(bare.general).toBeNull();
    expect(bare.versions).toEqual([]);
  });

  test("a source with no facts is dropped, and its empty streams with it", () => {
    const info = buildItemInfo(
      movie({
        MediaSources: [source({ MediaStreams: [stream({ Type: "Video" })] })],
      }),
      { t, isAdmin: true },
    );
    expect(info.versions).toEqual([]);
  });

  test("several versions are numbered, and named when they have a name", () => {
    const info = buildItemInfo(
      movie({
        MediaSources: [
          source({ Id: "a", Name: "4K", Container: "mkv" }),
          source({ Id: "b", Container: "mp4" }),
        ],
      }),
      { t, isAdmin: false },
    );
    expect(info.versions.map((version) => version.title)).toEqual([
      'item_info.version_named {"number":1,"name":"4K"}',
      'item_info.version_n {"number":2}',
    ]);
  });

  test("an episode names its show and its place in it", () => {
    const info = buildItemInfo(
      {
        Id: "e1",
        Type: "Episode",
        Name: "Pilot",
        SeriesName: "Twin Peaks",
        ParentIndexNumber: 1,
        IndexNumber: 1,
        ProviderIds: { Tvdb: "12345" },
      } as BaseItemDto,
      { t, isAdmin: false },
    );
    const rows = Object.fromEntries(
      (info.general?.rows ?? []).map((row) => [row.key, row.value]),
    );
    expect(rows.show).toBe("Twin Peaks");
    expect(rows.episode).toBe('item.season_episode {"season":1,"episode":1}');
    expect(rows.tvdb).toBe("12345");
  });

  test("several streams of a kind are numbered", () => {
    const info = buildItemInfo(
      movie({
        MediaSources: [
          source({
            MediaStreams: [
              stream({ Type: "Audio", Index: 1, Codec: "aac" }),
              stream({ Type: "Audio", Index: 2, Codec: "ac3" }),
            ],
          }),
        ],
      }),
      { t, isAdmin: false },
    );
    expect(info.versions[0].sections.map((section) => section.title)).toEqual([
      'item_info.audio_n {"number":1}',
      'item_info.audio_n {"number":2}',
    ]);
  });
});
