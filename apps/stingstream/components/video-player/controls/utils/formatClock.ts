/**
 * The player's clock, in the shape every player has used since the VCR: `m:ss`, and `h:mm:ss` once
 * there is an hour to show.
 *
 * `utils/time.ts`'s `formatTimeString` writes "0m 0s" and "1h 5m 3s", which is right for a library
 * row describing a runtime — a duration you read once — and wrong for a readout that ticks. Beside
 * a seek bar it reads as a measurement rather than a position, its width jumps as the words change
 * length, and "0m 0s" is a lot of characters for the start of a movie. The two want different
 * things, so this is a second formatter rather than a change to the first: `formatRuntimeTicksExact`
 * and friends are used by rows and cards all over the app, and none of them want `0:00`.
 *
 * The sign is the caller's business. Remaining time is drawn with a leading "-" beside the bar,
 * and a formatter that decided that for itself could not be used for elapsed.
 */

/** Milliseconds in the units the clock is written in. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/**
 * `0:00`, `12:34`, `1:02:03`.
 *
 * Anything that is not a finite, positive number of milliseconds is the start of the movie: a
 * player whose duration has not arrived yet shows `0:00`, never `NaN:aN` and never nothing at all.
 * Truncated rather than rounded, so the reading never shows a second the movie has not reached.
 */
export const formatClock = (ms: number | null | undefined): string => {
  const totalSeconds =
    ms == null || !Number.isFinite(ms) || ms <= 0
      ? 0
      : Math.floor(ms / MS_PER_SECOND);

  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor(
    (totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  );
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
};
