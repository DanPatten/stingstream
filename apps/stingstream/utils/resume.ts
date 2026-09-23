/**
 * Where a person left off, and whether Play should ask about it.
 *
 * Dan, 2026-09-22: "ALWAYS maintain unfinished movie/TV show's position, tied to a user's
 * profile. When clicking Play, show a dialog to resume (top option) or play from beginning.
 * Mimic Plex here." The position itself is the server's: `UserData.PlaybackPositionTicks`, kept
 * per user from the progress the players report. The server also owns the thresholds, and the
 * defaults stand (`MinResumePct` 5, `MaxResumePct` 90): under 5 % nothing is kept, past 90 % the
 * title is marked played and the position cleared. So this module never second-guesses a
 * position the server kept; it only refuses one it should not have (a played title's).
 *
 * Pure, and free of React Native, so `resume.test.ts` pins every rule.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { formatDuration, formatRuntimeTicks } from "@/utils/time";

type Resumable = Pick<BaseItemDto, "UserData" | "RunTimeTicks"> | null;

/** The position to resume from, in ticks, or 0 when there is nothing to resume. */
export const resumePositionTicks = (item: Resumable | undefined): number => {
  const ticks = item?.UserData?.PlaybackPositionTicks ?? 0;
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  // A title marked watched starts again from the top, whatever position was left behind.
  if (item?.UserData?.Played) return 0;
  return ticks;
};

/**
 * Whether pressing Play asks "Resume from 1:02:33" or "Play from beginning" first.
 *
 * `showResumeDialog` is the reader's own setting (Playback), on by default. Off, Play resumes
 * without asking, the way it always did when the setting was off.
 */
export const shouldAskToResume = (
  item: Resumable | undefined,
  settings: { showResumeDialog?: boolean },
): boolean =>
  resumePositionTicks(item) > 0 && settings.showResumeDialog !== false;

/** `1:02:33`, `12:04`: the clock a player's own scrubber shows. */
export const formatResumePosition = (ticks: number): string =>
  formatDuration(ticks);

/** How far through the title the position is, 0 to 1, for a progress bar. */
export const resumeFraction = (item: Resumable | undefined): number => {
  const ticks = resumePositionTicks(item);
  if (ticks <= 0) return 0;
  const percent = item?.UserData?.PlayedPercentage;
  if (percent != null && Number.isFinite(percent) && percent > 0) {
    return Math.min(1, percent / 100);
  }
  const runtime = item?.RunTimeTicks ?? 0;
  return runtime > 0 ? Math.min(1, ticks / runtime) : 0;
};

/** `1h 32m`: what is left, for the caption under the bar. `null` when it cannot be known. */
export const remainingAfterResume = (
  item: Resumable | undefined,
): string | null => {
  const ticks = resumePositionTicks(item);
  const runtime = item?.RunTimeTicks ?? 0;
  if (ticks <= 0 || runtime <= 0) return null;
  return formatRuntimeTicks(Math.max(0, runtime - ticks));
};
