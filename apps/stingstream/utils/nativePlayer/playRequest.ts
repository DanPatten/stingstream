/**
 * A normalized "play this item" request for the upcoming native iOS player.
 * Mirrors the query parameters the direct player screen already accepts so
 * both players can be driven from the same call sites.
 */
export interface PlayRequest {
  itemId: string;
  audioIndex?: number;
  subtitleIndex?: number;
  mediaSourceId?: string;
  bitrateValue?: number;
  offline: boolean;
  playbackPositionTicks?: number;
}

/**
 * Serialize a PlayRequest into the exact query string PlayButton's
 * handleNormalPlayFlow builds for /player/direct-player today: missing
 * optionals become empty strings and offline is "true"/"false".
 *
 * A missing position is left out rather than written as "0". The route reads
 * "0" as "start from the beginning" and it wins over the saved position, so a
 * caller that simply did not say (the TV top shelf, a remote Play command
 * without a start position) always restarted a title a person was halfway
 * through. Absent, the route resumes from the item's own saved position.
 */
export const toDirectPlayerQuery = (req: PlayRequest): string => {
  const queryParams = new URLSearchParams({
    itemId: req.itemId,
    audioIndex: req.audioIndex?.toString() ?? "",
    subtitleIndex: req.subtitleIndex?.toString() ?? "",
    mediaSourceId: req.mediaSourceId ?? "",
    bitrateValue: req.bitrateValue?.toString() ?? "",
    playbackPosition: req.playbackPositionTicks?.toString() ?? "",
    offline: req.offline ? "true" : "false",
  });
  if (req.playbackPositionTicks == null) queryParams.delete("playbackPosition");
  return queryParams.toString();
};
