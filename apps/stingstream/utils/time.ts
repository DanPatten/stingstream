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

export const runtimeTicksToSeconds = (
  ticks: number | null | undefined,
): string => {
  if (!ticks) return "0h 0m";

  const ticksPerMinute = 600000000;
  const ticksPerHour = 36000000000;

  const hours = Math.floor(ticks / ticksPerHour);
  const minutes = Math.floor((ticks % ticksPerHour) / ticksPerMinute);
  const seconds = Math.floor((ticks % ticksPerMinute) / 10000000);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
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
