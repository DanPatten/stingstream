/**
 * The position a playback report may carry.
 *
 * Every progress report overwrites the reader's saved position on the server, and a position of 0
 * clears it. So a report built before the player has really started, or while the resume seek has
 * not landed yet, must not say 0: the web player fired its first `progress` event at
 * `currentTime = 0`, before `loadedmetadata` had applied the resume seek, and that one report was
 * enough to wipe the place a person had stopped at (Dan, 2026-09-22: "ALWAYS maintain unfinished
 * movie/TV show's position").
 *
 * Until playback has started and the player has reported a real position, the report carries the
 * position playback began from, which is the last one the server was told anyway. The native
 * presented player already gated its reports the same way (`applyProgressTick`); the JS route did
 * not.
 */
export function reportablePositionTicks(
  currentTicks: number,
  startTicks: number,
  hasPlaybackStarted: boolean,
): number {
  const current = Number.isFinite(currentTicks) ? Math.max(0, currentTicks) : 0;
  const start = Number.isFinite(startTicks) ? Math.max(0, startTicks) : 0;
  if (!hasPlaybackStarted || current === 0) return start > 0 ? start : current;
  return current;
}
