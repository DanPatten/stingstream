/**
 * What "Get info" says about a title: its identity, and for every version its file and every
 * stream in it.
 *
 * Plex's own item menu has the same entry and the same shape (Dan, 2026-09-22: "mimic Plex"), and
 * this is the pure half of it. Kept out of the component so the rules a person will argue with
 * later (is H.264 level 41 "4.1", does a missing bitrate print "N/A", who sees a server path) are
 * pinned by `mediaInfo.test.ts` without rendering React or loading the SDK's runtime.
 *
 * Empty values are dropped rather than printed as a dash, and a section left with no rows is
 * dropped with them, so a title held by another server, which often arrives with no media source
 * at all, shows what is known and nothing else.
 */

import type {
  BaseItemDto,
  MediaSourceInfo,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import { formatBitrate } from "@/utils/bitrate";
import { formatDuration } from "@/utils/time";

/** The translator this module is handed. `(key) => key` in the tests. */
export type Translate = (key: string, args?: Record<string, unknown>) => string;

export interface InfoRow {
  key: string;
  label: string;
  value: string;
  /** Drawn in full, wrapping, with a copy control. A file path. */
  copyable?: boolean;
  /**
   * The version whose file this is, when the row is that version's own file: what "Show in
   * Explorer" asks the node to open. Never on a subtitle's path, which is a different file.
   */
  revealSourceId?: string;
}

export interface InfoSection {
  key: string;
  title: string;
  /** The stream's own name, under the section title: "English - Dolby Digital - 5.1". */
  subtitle?: string;
  rows: InfoRow[];
}

export interface InfoVersion {
  key: string;
  /** Only when the title has more than one version, or the one it has is named. */
  title?: string;
  sections: InfoSection[];
}

export interface ItemInfo {
  general: InfoSection | null;
  versions: InfoVersion[];
}

export interface ItemInfoOptions {
  t: Translate;
  /**
   * Server paths go to administrators only. They say where the owner keeps their files, which
   * is not a member's business, and a member could do nothing with one anyway.
   */
  isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** `4.2 GB`, `734 MB`. Binary steps, the way every file manager counts. */
export const formatFileSize = (bytes?: number | null): string | null => {
  if (!bytes || bytes <= 0) return null;
  const exponent = Math.min(
    SIZE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[exponent]}`;
};

/** A bitrate, or nothing: `formatBitrate` prints "N/A" for a missing one, which is not a value. */
export const formatBitrateOrNull = (bps?: number | null): string | null =>
  bps && bps > 0 ? formatBitrate(bps) : null;

/** `23.976 fps`, `24 fps`, `59.94 fps`. Three places at most, and no trailing zeros. */
export const formatFrameRate = (fps?: number | null): string | null => {
  if (!fps || !Number.isFinite(fps) || fps <= 0) return null;
  return `${Number(fps.toFixed(3))} fps`;
};

/** `48 kHz`, `44.1 kHz`. */
export const formatSampleRate = (hz?: number | null): string | null => {
  if (!hz || hz <= 0) return null;
  return `${Number((hz / 1000).toFixed(1))} kHz`;
};

/**
 * The level as a codec's own documentation writes it.
 *
 * The server reports H.264 as ten times the level (41 is 4.1) and HEVC as thirty times it (153 is
 * 5.1), because that is how each bitstream stores it. Printed raw, "153" means nothing to anybody.
 * Any other codec's level is printed as it came.
 */
export const formatCodecLevel = (
  codec?: string | null,
  level?: number | null,
): string | null => {
  if (level == null || !Number.isFinite(level) || level <= 0) return null;
  const name = (codec ?? "").toLowerCase();
  if (name === "h264" || name === "avc") return String(level / 10);
  if (name === "hevc" || name === "h265") {
    return String(Number((level / 30).toFixed(1)));
  }
  return String(level);
};

/** `6 (5.1)`, `2 (stereo)`, or whichever half is known. */
export const formatChannels = (
  channels?: number | null,
  layout?: string | null,
): string | null => {
  if (channels && layout) return `${channels} (${layout})`;
  if (channels) return String(channels);
  return layout || null;
};

/** "Dolby Vision" where the server says DOVI, otherwise its own range name: `HDR10`, `SDR`. */
export const formatVideoRange = (stream: MediaStream): string | null => {
  if (
    stream.VideoRangeType?.startsWith("DOVI") ||
    stream.DvVersionMajor != null
  ) {
    return "Dolby Vision";
  }
  const type = stream.VideoRangeType;
  if (type && type !== "Unknown") return type;
  const range = stream.VideoRange;
  return range && range !== "Unknown" ? range : null;
};

/** A date a person reads: `September 22, 2026` in their own locale. */
export const formatDate = (iso?: string | null): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

// ---------------------------------------------------------------------------
// The sheet's content
// ---------------------------------------------------------------------------

type Pair = [key: string, value: string | null | undefined, copyable?: boolean];

const rowsOf = (t: Translate, pairs: Pair[]): InfoRow[] =>
  pairs
    .filter(
      (pair): pair is [string, string, boolean | undefined] =>
        typeof pair[1] === "string" && pair[1].trim().length > 0,
    )
    .map(([key, value, copyable]) => ({
      key,
      label: t(`item_info.${key}`),
      value,
      ...(copyable ? { copyable: true } : {}),
    }));

const upper = (value?: string | null) => (value ? value.toUpperCase() : null);

const general = (item: BaseItemDto, t: Translate): InfoSection | null => {
  const ids = item.ProviderIds ?? {};
  const episode =
    item.Type === "Episode" &&
    item.ParentIndexNumber != null &&
    item.IndexNumber != null
      ? t("item.season_episode", {
          season: item.ParentIndexNumber,
          episode: item.IndexNumber,
        })
      : null;

  const rows = rowsOf(t, [
    ["show", item.Type === "Episode" ? item.SeriesName : null],
    ["episode", episode],
    ["year", item.ProductionYear ? String(item.ProductionYear) : null],
    [
      "runtime",
      item.RunTimeTicks ? formatDuration(item.RunTimeTicks) : undefined,
    ],
    ["added", formatDate(item.DateCreated)],
    ["tmdb", ids.Tmdb],
    ["imdb", ids.Imdb],
    ["tvdb", ids.Tvdb],
  ]);
  return rows.length
    ? { key: "general", title: t("item_info.general"), rows }
    : null;
};

const flag = (t: Translate, on?: boolean | null) =>
  on ? t("item_info.yes") : null;

const videoSection = (
  stream: MediaStream,
  t: Translate,
  index: number,
  count: number,
): InfoSection => ({
  key: `video-${stream.Index ?? index}`,
  title:
    count > 1
      ? t("item_info.video_n", { number: index + 1 })
      : t("item_info.video"),
  subtitle: stream.DisplayTitle ?? undefined,
  rows: rowsOf(t, [
    ["codec", upper(stream.Codec)],
    ["profile", stream.Profile],
    ["level", formatCodecLevel(stream.Codec, stream.Level)],
    [
      "resolution",
      stream.Width && stream.Height ? `${stream.Width}×${stream.Height}` : null,
    ],
    ["aspect_ratio", stream.AspectRatio],
    ["bit_depth", stream.BitDepth ? `${stream.BitDepth} bit` : null],
    [
      "frame_rate",
      formatFrameRate(stream.RealFrameRate ?? stream.AverageFrameRate),
    ],
    ["dynamic_range", formatVideoRange(stream)],
    ["color_space", stream.ColorSpace],
    ["color_primaries", stream.ColorPrimaries],
    ["color_transfer", stream.ColorTransfer],
    ["pixel_format", stream.PixelFormat],
    ["bitrate", formatBitrateOrNull(stream.BitRate)],
  ]),
});

const audioSection = (
  stream: MediaStream,
  t: Translate,
  index: number,
  count: number,
): InfoSection => ({
  key: `audio-${stream.Index ?? index}`,
  title:
    count > 1
      ? t("item_info.audio_n", { number: index + 1 })
      : t("item_info.audio"),
  subtitle: stream.DisplayTitle ?? undefined,
  rows: rowsOf(t, [
    ["codec", upper(stream.Codec)],
    ["profile", stream.Profile],
    ["language", stream.Language],
    ["channels", formatChannels(stream.Channels, stream.ChannelLayout)],
    ["bitrate", formatBitrateOrNull(stream.BitRate)],
    ["sample_rate", formatSampleRate(stream.SampleRate)],
    ["bit_depth", stream.BitDepth ? `${stream.BitDepth} bit` : null],
    ["default", flag(t, stream.IsDefault)],
    ["forced", flag(t, stream.IsForced)],
  ]),
});

const subtitleSection = (
  stream: MediaStream,
  t: Translate,
  index: number,
  count: number,
  isAdmin: boolean,
): InfoSection => ({
  key: `subtitle-${stream.Index ?? index}`,
  title:
    count > 1
      ? t("item_info.subtitle_n", { number: index + 1 })
      : t("item_info.subtitle"),
  subtitle: stream.DisplayTitle ?? undefined,
  rows: rowsOf(t, [
    ["format", upper(stream.Codec)],
    ["language", stream.Language],
    [
      "location",
      stream.IsExternal ? t("item_info.external") : t("item_info.embedded"),
    ],
    ["path", isAdmin && stream.IsExternal ? stream.Path : null, true],
    ["default", flag(t, stream.IsDefault)],
    ["forced", flag(t, stream.IsForced)],
    ["hearing_impaired", flag(t, stream.IsHearingImpaired)],
  ]),
});

/** Marks a version's own path row with the version it belongs to. */
const withRevealSource = (
  source: MediaSourceInfo,
  rows: InfoRow[],
): InfoRow[] =>
  source.Id
    ? rows.map((row) =>
        row.key === "path"
          ? { ...row, revealSourceId: source.Id ?? undefined }
          : row,
      )
    : rows;

const version = (
  source: MediaSourceInfo,
  index: number,
  count: number,
  { t, isAdmin }: ItemInfoOptions,
): InfoVersion => {
  const streams = source.MediaStreams ?? [];
  const video = streams.filter((stream) => stream.Type === "Video");
  const audio = streams.filter((stream) => stream.Type === "Audio");
  const subtitles = streams.filter((stream) => stream.Type === "Subtitle");

  const file: InfoSection = {
    key: "file",
    title: t("item_info.file"),
    rows: withRevealSource(
      source,
      rowsOf(t, [
        ["path", isAdmin ? source.Path : null, true],
        ["size", formatFileSize(source.Size)],
        [
          "duration",
          source.RunTimeTicks ? formatDuration(source.RunTimeTicks) : null,
        ],
        ["container", upper(source.Container)],
        ["bitrate", formatBitrateOrNull(source.Bitrate)],
      ]),
    ),
  };

  const sections = [
    file,
    ...video.map((stream, i) => videoSection(stream, t, i, video.length)),
    ...audio.map((stream, i) => audioSection(stream, t, i, audio.length)),
    ...subtitles.map((stream, i) =>
      subtitleSection(stream, t, i, subtitles.length, isAdmin),
    ),
  ].filter((section) => section.rows.length > 0);

  const name = source.Name?.trim();
  return {
    key: source.Id ?? String(index),
    title:
      count > 1
        ? name
          ? t("item_info.version_named", { number: index + 1, name })
          : t("item_info.version_n", { number: index + 1 })
        : name || undefined,
    sections,
  };
};

/** Everything "Get info" shows, in the order it shows it. */
export const buildItemInfo = (
  item: BaseItemDto,
  options: ItemInfoOptions,
): ItemInfo => {
  const sources = item.MediaSources ?? [];
  return {
    general: general(item, options.t),
    versions: sources
      .map((source, index) => version(source, index, sources.length, options))
      .filter((entry) => entry.sections.length > 0),
  };
};
