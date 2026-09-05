/**
 * StingStream.Core's `/movies`, `/series` and `/queue` endpoints pass Radarr's
 * and Sonarr's own JSON straight through (see their OpenAPI descriptions —
 * "the movie as Radarr stored it" — and `packages/api-client`'s generated
 * types, which have no response schema for these because of that). These are
 * hand-written, deliberately loose types for the handful of fields the
 * Manage screens actually render; they are not a full model of either app's
 * resource shape.
 */

export interface ArrImage {
  coverType: string;
  remoteUrl?: string;
  url?: string;
}

export interface ArrMovie {
  id: number;
  title: string;
  year: number;
  overview?: string;
  status?: string;
  monitored: boolean;
  hasFile: boolean;
  isAvailable?: boolean;
  qualityProfileId: number;
  sizeOnDisk?: number;
  tmdbId: number;
  imdbId?: string;
  images?: ArrImage[];
  path?: string;
  minimumAvailability?: string;
}

export interface ArrSeries {
  id: number;
  title: string;
  year: number;
  overview?: string;
  status?: string;
  monitored: boolean;
  qualityProfileId: number;
  seasonFolder?: boolean;
  seriesType?: string;
  sizeOnDisk?: number;
  tvdbId: number;
  imdbId?: string;
  images?: ArrImage[];
  path?: string;
  statistics?: {
    episodeCount?: number;
    episodeFileCount?: number;
    seasonCount?: number;
    sizeOnDisk?: number;
    percentOfEpisodes?: number;
  };
}

/**
 * One row of `/api/v3/queue` from either app (Radarr and Sonarr agree on
 * this shape closely enough for one type to cover both). `sizeleft`/`size`
 * already reflect the embedded engine's own progress — Core does not need to
 * merge in a second source for this.
 */
export interface ArrQueueItem {
  id: number;
  title?: string;
  movieId?: number;
  seriesId?: number;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  estimatedCompletionTime?: string;
  status?: string;
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  errorMessage?: string;
  downloadClient?: string;
  protocol?: string;
  indexer?: string;
  quality?: { quality?: { name?: string } };
}

export function posterUrl(images?: ArrImage[]): string | undefined {
  return images?.find((i) => i.coverType === "poster")?.remoteUrl;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exp;
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}
