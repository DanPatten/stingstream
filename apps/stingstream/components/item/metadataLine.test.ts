import { describe, expect, test } from "bun:test";
import type {
  BaseItemDto,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import {
  buildBadges,
  buildMetadataLine,
  formatRemaining,
  formatYears,
  streamsOf,
} from "./metadata";

const TICKS_PER_SECOND = 10_000_000;
const seconds = (value: number) => value * TICKS_PER_SECOND;
const minutes = (value: number) => seconds(value * 60);
const hours = (value: number) => minutes(value * 60);

const video = (stream: Partial<MediaStream>): MediaStream =>
  ({ Type: "Video", ...stream }) as MediaStream;
const audio = (stream: Partial<MediaStream>): MediaStream =>
  ({ Type: "Audio", ...stream }) as MediaStream;

// The runtime formatter itself is `utils/time.ts`'s, and so are its tests
// (`utils/time.test.ts`) — the home hero renders the same string. What is
// tested here is what this module adds: what is *left* of a runtime, the years
// a title covers, the segments of the line, and the quality badges.

describe("formatRemaining", () => {
  test("is what is left, for the resume label", () => {
    expect(formatRemaining(hours(1) + minutes(34), minutes(20))).toBe("1h 14m");
  });

  test("never goes negative when the position overshoots the runtime", () => {
    expect(formatRemaining(minutes(10), minutes(11))).toBeNull();
  });

  test("treats a missing position as the start", () => {
    expect(formatRemaining(minutes(45), null)).toBe("45m");
  });
});

describe("formatYears", () => {
  test("a movie is one year", () => {
    expect(
      formatYears({ Type: "Movie", ProductionYear: 1922 } as BaseItemDto),
    ).toBe("1922");
  });

  test("a finished series is a span", () => {
    expect(
      formatYears({
        Type: "Series",
        StartDate: "1962-09-26T00:00:00.0000000Z",
        EndDate: "1971-03-23T00:00:00.0000000Z",
      } as BaseItemDto),
    ).toBe("1962–1971");
  });

  test("a one-season series is not a span of one year to itself", () => {
    expect(
      formatYears({
        Type: "Series",
        StartDate: "2019-01-01T00:00:00.0000000Z",
        EndDate: "2019-12-01T00:00:00.0000000Z",
      } as BaseItemDto),
    ).toBe("2019");
  });

  test("a running series is open-ended", () => {
    expect(
      formatYears({
        Type: "Series",
        StartDate: "2019-01-01T00:00:00.0000000Z",
        Status: "Continuing",
      } as BaseItemDto),
    ).toBe("2019–");
  });

  test("an ended series with no end date is not left open", () => {
    expect(
      formatYears({
        Type: "Series",
        StartDate: "2019-01-01T00:00:00.0000000Z",
        Status: "Ended",
      } as BaseItemDto),
    ).toBe("2019");
  });

  test("falls back to the production year when there is no start date", () => {
    expect(
      formatYears({ Type: "Series", ProductionYear: 1990 } as BaseItemDto),
    ).toBe("1990–");
  });

  test("returns null when the item has no year at all", () => {
    expect(formatYears({ Type: "Movie" } as BaseItemDto)).toBeNull();
  });
});

describe("buildMetadataLine", () => {
  test("is the plan's own example, in order", () => {
    expect(
      buildMetadataLine({
        Type: "Movie",
        ProductionYear: 1922,
        RunTimeTicks: hours(1) + minutes(34),
        OfficialRating: "NR",
        Genres: ["Horror", "Fantasy"],
      } as BaseItemDto),
    ).toEqual(["1922", "1h 34m", "NR", "Horror, Fantasy"]);
  });

  test("drops every segment the item does not have", () => {
    expect(buildMetadataLine({ Type: "Movie" } as BaseItemDto)).toEqual([]);
    expect(
      buildMetadataLine({
        Type: "Movie",
        ProductionYear: 2001,
        Genres: [],
      } as BaseItemDto),
    ).toEqual(["2001"]);
  });

  test("names at most three genres, so the line stays a line", () => {
    expect(
      buildMetadataLine({
        Type: "Movie",
        Genres: ["Action", "Comedy", "Drama", "Fantasy", "Horror"],
      } as BaseItemDto),
    ).toEqual(["Action, Comedy, Drama"]);
  });

  test("an episode leads with its own label", () => {
    expect(
      buildMetadataLine(
        {
          Type: "Episode",
          ProductionYear: 1963,
          RunTimeTicks: minutes(25),
        } as BaseItemDto,
        { episodeLabel: "Season 1 · Episode 3" },
      ),
    ).toEqual(["Season 1 · Episode 3", "1963", "25m"]);
  });
});

describe("buildBadges", () => {
  test("nothing to say about nothing", () => {
    expect(buildBadges(null)).toEqual([]);
    expect(buildBadges([])).toEqual([]);
  });

  test("UHD earns 4K; 1080p does not", () => {
    expect(buildBadges([video({ Width: 3840, Height: 2160 })])).toEqual(["4K"]);
    expect(buildBadges([video({ Width: 4096, Height: 1716 })])).toEqual(["4K"]);
    expect(buildBadges([video({ Width: 1920, Height: 1080 })])).toEqual([]);
  });

  test("Dolby Vision wins over HDR rather than printing both", () => {
    expect(
      buildBadges([
        video({ Width: 3840, VideoRange: "HDR", VideoRangeType: "DOVI" }),
      ]),
    ).toEqual(["4K", "Dolby Vision"]);
    expect(buildBadges([video({ Width: 1920, DvVersionMajor: 1 })])).toEqual([
      "Dolby Vision",
    ]);
  });

  test("HDR10, HLG and PQ all read as HDR", () => {
    expect(
      buildBadges([video({ VideoRange: "HDR", VideoRangeType: "HDR10" })]),
    ).toEqual(["HDR"]);
    expect(buildBadges([video({ VideoRangeType: "HLG" })])).toEqual(["HDR"]);
    expect(buildBadges([video({ VideoRangeType: "PQ" as never })])).toEqual([
      "HDR",
    ]);
    expect(buildBadges([video({ VideoRange: "SDR" })])).toEqual([]);
  });

  test("Atmos is read off the profile or the display title", () => {
    expect(
      buildBadges([audio({ Profile: "Dolby Atmos", Channels: 8 })]),
    ).toContain("Atmos");
    expect(
      buildBadges([
        audio({ DisplayTitle: "English - TrueHD Atmos 7.1", Channels: 8 }),
      ]),
    ).toContain("Atmos");
  });

  test("the channel badge is the best track, not the first", () => {
    expect(
      buildBadges([
        audio({ ChannelLayout: "stereo", Channels: 2 }),
        audio({ ChannelLayout: "5.1", Channels: 6 }),
      ]),
    ).toEqual(["5.1"]);
  });

  test("stereo and mono are the default, not a feature", () => {
    expect(
      buildBadges([audio({ ChannelLayout: "stereo", Channels: 2 })]),
    ).toEqual([]);
    expect(
      buildBadges([audio({ ChannelLayout: "mono", Channels: 1 })]),
    ).toEqual([]);
  });

  test("the full set stays in a readable order", () => {
    expect(
      buildBadges([
        video({ Width: 3840, Height: 2160, VideoRangeType: "DOVI" }),
        audio({ Profile: "Dolby Atmos", ChannelLayout: "7.1", Channels: 8 }),
      ]),
    ).toEqual(["4K", "Dolby Vision", "Atmos", "7.1"]);
  });
});

describe("streamsOf", () => {
  const stream = video({ Width: 1920 });

  test("prefers the source the user actually chose", () => {
    expect(
      streamsOf({ MediaStreams: [stream] }, {
        MediaSources: [{ MediaStreams: [] }],
      } as BaseItemDto),
    ).toEqual([stream]);
  });

  test("falls back to the item's first source, then to its own streams", () => {
    expect(
      streamsOf(null, {
        MediaSources: [{ MediaStreams: [stream] }],
      } as BaseItemDto),
    ).toEqual([stream]);
    expect(streamsOf(null, { MediaStreams: [stream] } as BaseItemDto)).toEqual([
      stream,
    ]);
    expect(streamsOf(null, null)).toEqual([]);
  });
});
