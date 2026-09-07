/**
 * The route params that restart the player on a different copy of the same title.
 *
 * `app/(auth)/player/direct-player.tsx` already re-negotiates a stream by rewriting its own route
 * and letting Expo Router remount it — that is how a mid-playback subtitle burn-in, an audio switch
 * while transcoding and a bitrate change all work (`replaceWithTrackSelection`). Switching holder
 * is the same move with `mediaSourceId` changed, so the query is built here rather than a fourth
 * time inline, and can be tested without a player.
 *
 * The two things that are easy to get wrong, and are therefore what the tests pin:
 *
 *  * **Position is carried in ticks.** The player's shared value is milliseconds; the route param
 *    is Jellyfin ticks, because it is also what a deep link carries and what `UserData` stores.
 *    Losing the conversion loses the user's place by a factor of 10,000.
 *  * **A client-side sidecar cannot survive the switch.** It only exists on the dying mpv handle,
 *    so the new stream must be negotiated with "no subtitles" (`toServerSubtitleIndex`) rather than
 *    with a sentinel the server would either reject or resolve to some real stream.
 */

import { toServerSubtitleIndex } from "@/utils/subtitles/subtitleIndex";
import { msToTicks } from "@/utils/time";

export interface SwitchQueryInput {
  itemId: string;
  /** The MediaSource to play instead — the whole point of the switch. */
  mediaSourceId: string;
  /** Where playback is now, in milliseconds, as the player's shared value holds it. */
  progressMs: number;
  audioIndex?: number | null;
  /** The live selection, which may be a client-side sidecar. */
  subtitleIndex?: number | null;
  bitrateValue?: number | null;
  /** Kept so a switch inside an offline context does not navigate back online. */
  offline?: boolean;
}

/**
 * Build the query string for `router.replace("player/direct-player?…")`.
 *
 * Empty strings rather than omitted keys for the optional indexes, matching what the existing
 * replace paths write: the player parses a blank param back to "use the media default", where a
 * missing one would be indistinguishable from a deep link that never had it.
 */
export const buildSwitchQuery = (input: SwitchQueryInput): string => {
  const params = new URLSearchParams({
    itemId: input.itemId,
    audioIndex: input.audioIndex != null ? String(input.audioIndex) : "",
    subtitleIndex: String(toServerSubtitleIndex(input.subtitleIndex)),
    mediaSourceId: input.mediaSourceId,
    bitrateValue: input.bitrateValue != null ? String(input.bitrateValue) : "",
    playbackPosition: String(msToTicks(input.progressMs)),
  });
  // Only ever set, never set to "false": `direct-player` reads it as `=== "true"`, and an explicit
  // `offline=false` in the URL would read as offline to any other consumer of the route.
  if (input.offline) params.set("offline", "true");
  return params.toString();
};
