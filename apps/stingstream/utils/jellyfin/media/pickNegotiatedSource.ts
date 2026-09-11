import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client/models";

/**
 * Which of PlaybackInfo's media sources the caller actually asked for.
 *
 * `MediaSources[0]` is right today because Jellyfin filters its response down to the requested
 * source when `MediaSourceId` is posted, and the callers all post one. But the list it returns for
 * a title several servers hold is *ranked*, and taking the first of a ranked list means "whatever
 * the scorer preferred" — so the day that filtering changes, or a call goes out without an id, the
 * player silently starts a different copy from the one somebody chose. That failure has no symptom
 * beyond a movie coming from the wrong machine, which is precisely what the chooser exists to stop.
 *
 * Asking for the id back is a one-line guard against it, and does nothing at all in every case
 * that already worked.
 */
export const pickNegotiatedSource = (
  sources: MediaSourceInfo[] | null | undefined,
  requestedId: string | null | undefined,
): MediaSourceInfo | undefined =>
  (requestedId ? sources?.find((s) => s.Id === requestedId) : undefined) ??
  sources?.[0];
