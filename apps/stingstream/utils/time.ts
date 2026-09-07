/** Jellyfin counts in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;
const TICKS_PER_MINUTE = 60 * TICKS_PER_SECOND;
const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/**
 * A runtime a person would say out loud: `20s`, `34m`, `1h 34m`, `2h`.
 *
 * **Under a minute it counts seconds.** The old version floored to whole
 * minutes, so a twenty-second clip rendered as "0m" — which is not a duration,
 * it is the absence of one, and it shipped on the details page's Play button
 * (pass-02 F-26) and again in the home hero, where WP4 had to work around it
 * locally. One implementation now, so the next screen that needs a runtime
 * cannot get the broken one.
 *
 * Returns `null` when there is no runtime at all, so a caller can drop the
 * segment instead of printing a placeholder. `runtimeTicksToMinutes` is the
 * always-a-string wrapper for callers that have nowhere to put a `null`.
 */
export const formatRuntimeTicks = (
  ticks: number | null | undefined,
): string | null => {
  if (!ticks || ticks <= 0) return null;

  if (ticks < TICKS_PER_MINUTE) {
    return `${Math.max(1, Math.round(ticks / TICKS_PER_SECOND))}s`;
  }

  const hours = Math.floor(ticks / TICKS_PER_HOUR);
  const minutes = Math.round((ticks % TICKS_PER_HOUR) / TICKS_PER_MINUTE);
  // 1h 60m is not a thing anyone writes.
  if (minutes === 60) return `${hours + 1}h`;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
};

/**
 * The same string, with `0m` where there is no runtime.
 *
 * Kept for the fifteen-odd call sites that render straight into a `Text` and
 * have nothing sensible to do with a `null`. Prefer `formatRuntimeTicks` in
 * new code: a row that can omit the runtime reads better than one that claims
 * a title is zero minutes long.
 */
export const runtimeTicksToMinutes = (
  ticks: number | null | undefined,
): string => formatRuntimeTicks(ticks) ?? "0m";

/**
 * The same runtime, exact, with the seconds shown **only when there are any**.
 *
 * `formatRuntimeTicks` rounds, which is right for a badge ("1h 34m") and wrong
 * for a list that is also claiming to show seconds. This one floors, so a
 * 25m 30s episode reads "25m 30s" rather than "26m", and a round one reads
 * "25m" rather than the "25m 0s" every episode row used to end with — a zero
 * that was there for every title in the library whose runtime happened to land
 * on a whole minute, which is most of them.
 *
 * `null` when there is no runtime, so a row omits the line instead of printing
 * "0h 0m" under an episode nobody has a duration for.
 */
export const formatRuntimeTicksExact = (
  ticks: number | null | undefined,
): string | null => {
  if (!ticks || ticks <= 0) return null;

  const hours = Math.floor(ticks / TICKS_PER_HOUR);
  const minutes = Math.floor((ticks % TICKS_PER_HOUR) / TICKS_PER_MINUTE);
  const seconds = Math.floor((ticks % TICKS_PER_MINUTE) / TICKS_PER_SECOND);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  // The minutes are kept when there are hours *and* seconds either side of
  // them: "1h 5s" invites the reader to work out whether a part is missing.
  if (minutes > 0 || (hours > 0 && seconds > 0)) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
};

// t: ms
export const formatTimeString = (
  t: number | null | undefined,
  unit: "s" | "ms" | "tick" = "ms",
): string => {
  if (t === null || t === undefined || !Number.isFinite(t)) return "0:00";

  let seconds: number;
  switch (unit) {
    case "s":
      seconds = Math.floor(t);
      break;
    case "ms":
      seconds = Math.floor(t / 1000);
      break;
    case "tick":
      seconds = Math.floor(t / 10000000);
      break;
    default:
      seconds = Math.floor(t / 1000); // Default to ms if an invalid type is provided
  }

  if (seconds < 0) return "0:00";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
};

export const secondsToTicks = (seconds?: number | undefined) => {
  if (!seconds) return 0;
  return Math.floor(seconds * 10000000);
};

export const ticksToSeconds = (ticks?: number | undefined) => {
  if (!ticks) return 0;
  return Math.floor(ticks / 10000000);
};

export const msToTicks = (ms?: number | undefined) => {
  if (!ms) return 0;
  return Math.floor(ms * 10000);
};

export const ticksToMs = (ticks?: number | undefined) => {
  if (!ticks) return 0;
  return Math.floor(ticks / 10000);
};

export const secondsToMs = (seconds?: number | undefined) => {
  if (!seconds) return 0;
  return Math.floor(seconds * 1000);
};

export const msToSeconds = (ms?: number | undefined) => {
  if (!ms) return 0;
  return Math.floor(ms / 1000);
};

/**
 * Formats ticks to a compact duration string (MM:SS or HH:MM:SS).
 * Useful for music track durations.
 */
export const formatDuration = (ticks: number | null | undefined): string => {
  if (!ticks) return "0:00";

  const totalSeconds = Math.floor(ticks / 10000000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};
