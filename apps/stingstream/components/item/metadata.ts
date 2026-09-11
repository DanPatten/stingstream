/**
 * The one line under a title on the details page: `1922 · 1h 34m · NR ·
 * Horror, Fantasy`, plus the quality badges beside it.
 *
 * Pure, and kept out of the component, for two reasons. The first is that every
 * rule in here is a rule somebody will argue about later — is a 3840-wide file
 * "4K", does a Dolby Vision title also say HDR, what does a twenty-second clip
 * show instead of "0m" — and `metadataLine.test.ts` can pin all of them without
 * rendering React or loading the Jellyfin SDK. The second is that pass-02 shipped
 * "0m" as the runtime of a 20-second item (F-26): a fallback nobody could see was
 * wrong until it was on screen.
 */

import type {
  BaseItemDto,
  MediaSourceInfo,
  MediaStream,
} from "@jellyfin/sdk/lib/generated-client/models";
import { formatRuntimeTicks } from "@/utils/time";

/**
 * The runtime formatter itself lives in `utils/time.ts`, beside every other
 * tick helper and with its own tests. It was here first, and while it was, the
 * home hero had to carry a *second* copy of the same fix — which is exactly how
 * "0m" survived in one place after being fixed in the other. Re-exported so the
 * details page keeps importing its formatting from one module.
 */
export { formatRuntimeTicks };

/** How much of a runtime is left, for the Play button's resume label. */
export const formatRemaining = (
  runtimeTicks: number | null | undefined,
  positionTicks: number | null | undefined,
): string | null =>
  formatRuntimeTicks(Math.max(0, (runtimeTicks ?? 0) - (positionTicks ?? 0)));

const year = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The years a title covers.
 *
 * A movie is one year. A series is a span, and an ongoing one has no end — which
 * is written the way a reference book writes it, `1962–` with an en dash, not
 * `1962 - undefined`.
 */
export const formatYears = (item: BaseItemDto): string | null => {
  const start = year(item.StartDate) ?? item.ProductionYear ?? null;
  if (item.Type !== "Series") return start ? String(start) : null;

  const end = year(item.EndDate);
  if (!start) return end ? String(end) : null;
  if (!end) return item.Status === "Ended" ? String(start) : `${start}–`;
  return end === start ? String(start) : `${start}–${end}`;
};

export interface MetadataLineOptions {
  /** How many genres to name before the line starts reading as a list. */
  maxGenres?: number;
  /** "Season 1 · Episode 3", localised by the caller. */
  episodeLabel?: string | null;
}

/**
 * The segments of the metadata line, in order, with the empty ones dropped.
 *
 * Returned as an array rather than a joined string so the component can draw its
 * own separators — a middle dot in `tertiary` between segments in `secondary`
 * reads as punctuation, where a dot inside the same run of text reads as part of
 * the sentence.
 */
export const buildMetadataLine = (
  item: BaseItemDto,
  options: MetadataLineOptions = {},
): string[] => {
  const { maxGenres = 3, episodeLabel } = options;

  const segments: (string | null | undefined)[] = [
    episodeLabel,
    formatYears(item),
    formatRuntimeTicks(item.RunTimeTicks),
    item.OfficialRating,
    item.Genres?.length ? item.Genres.slice(0, maxGenres).join(", ") : null,
  ];

  return segments.filter((segment): segment is string => Boolean(segment));
};

// ---------------------------------------------------------------------------
// Quality badges
// ---------------------------------------------------------------------------

/** 4K is a marketing name for a range of widths; DCI 4K is 4096, UHD is 3840. */
const UHD_MIN_WIDTH = 3400;
const UHD_MIN_HEIGHT = 2000;

const CHANNEL_LABELS: Record<string, string> = {
  mono: "Mono",
  stereo: "Stereo",
  "2.0": "Stereo",
  "2.1": "2.1",
  "5.1": "5.1",
  "6.1": "6.1",
  "7.1": "7.1",
};

const isDolbyVision = (stream: MediaStream): boolean =>
  stream.VideoRangeType === "DOVI" ||
  stream.DvVersionMajor != null ||
  stream.DvVersionMinor != null;

const isHdr = (stream: MediaStream): boolean => {
  const range =
    `${stream.VideoRange ?? ""} ${stream.VideoRangeType ?? ""}`.toUpperCase();
  return range.includes("HDR") || range.includes("HLG") || range.includes("PQ");
};

const isAtmos = (stream: MediaStream): boolean =>
  `${stream.Profile ?? ""} ${stream.DisplayTitle ?? ""} ${stream.Title ?? ""}`
    .toLowerCase()
    .includes("atmos");

/**
 * The badges beside the metadata line: `4K`, `HDR` or `Dolby Vision`, `Atmos`,
 * `5.1`.
 *
 * Four at most, and never both `Dolby Vision` and `HDR` — a DV file almost
 * always carries an HDR10 base layer as well, so listing both says the same
 * thing twice and pushes the useful badges off a phone's line.
 */
export const buildBadges = (
  streams: MediaStream[] | null | undefined,
): string[] => {
  if (!streams?.length) return [];

  const video = streams.find((stream) => stream.Type === "Video");
  const audio = streams.filter((stream) => stream.Type === "Audio");
  const badges: string[] = [];

  if (video) {
    if (
      (video.Width ?? 0) >= UHD_MIN_WIDTH ||
      (video.Height ?? 0) >= UHD_MIN_HEIGHT
    ) {
      badges.push("4K");
    }
    if (isDolbyVision(video)) badges.push("Dolby Vision");
    else if (isHdr(video)) badges.push("HDR");
  }

  if (audio.some(isAtmos)) badges.push("Atmos");

  // The best track the file has, not the first: a 5.1 mix listed after a stereo
  // commentary track is still what the title is capable of.
  const best = audio.reduce<MediaStream | null>(
    (winner, stream) =>
      (stream.Channels ?? 0) > (winner?.Channels ?? 0) ? stream : winner,
    null,
  );
  const layout = best?.ChannelLayout?.toLowerCase();
  const label = layout ? CHANNEL_LABELS[layout] : undefined;
  // Mono and stereo are the default, not a feature; a badge for them is noise.
  if (label && label !== "Mono" && label !== "Stereo") badges.push(label);

  return badges;
};

/** The streams a details page should describe: the chosen source, or the item. */
export const streamsOf = (
  source: MediaSourceInfo | null | undefined,
  item: BaseItemDto | null | undefined,
): MediaStream[] =>
  source?.MediaStreams ??
  item?.MediaSources?.[0]?.MediaStreams ??
  item?.MediaStreams ??
  [];
