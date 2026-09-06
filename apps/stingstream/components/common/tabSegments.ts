/**
 * The part of `Tabs` that has no React in it, so it can be tested with plain
 * `bun test` — `bun:test` cannot load React Native, and the interesting part of
 * a tab bar is which segment is selected, not how it is drawn.
 */

export interface Segment {
  key: string;
  label: string;
  /** A count, a state — drawn after the label. */
  badge?: string | number;
  disabled?: boolean;
}

export type TabsLayout = "underline" | "pills";

/**
 * Underline tabs from `medium` up, pill segments on a phone.
 *
 * Underlines need room for a rule the width of the label and a gap either
 * side; on a 390 px screen four of them either wrap or shrink to unreadable.
 * Pills scroll horizontally instead, which is the phone idiom anyway.
 */
export const tabsLayoutFor = (breakpoint: string): TabsLayout =>
  breakpoint === "compact" ? "pills" : "underline";

/**
 * The segment a tab bar should actually show as selected.
 *
 * A screen's `value` can be stale — a section removed because the user is no
 * longer an administrator, a key read from a deep link, a persisted choice from
 * a build that had one more tab. A bar that renders *no* selection in that case
 * looks broken and, worse, leaves the screen showing content that matches
 * nothing highlighted. Falling back to the first selectable segment keeps the
 * two in step.
 *
 * Returns `undefined` only when there is nothing selectable at all.
 */
export const resolveSegment = (
  segments: readonly Segment[],
  value: string | undefined,
): string | undefined => {
  const selectable = segments.filter((segment) => !segment.disabled);
  if (selectable.some((segment) => segment.key === value)) return value;
  return selectable[0]?.key;
};

/**
 * Whether pressing a segment should do anything.
 *
 * Disabled segments and the one already selected are both no-ops; re-selecting
 * the current tab would otherwise re-run whatever the screen does on change
 * (refetch, scroll to top, reset a filter) on every stray tap.
 */
export const shouldChangeSegment = (
  segments: readonly Segment[],
  current: string | undefined,
  next: string,
): boolean => {
  const target = segments.find((segment) => segment.key === next);
  if (!target || target.disabled) return false;
  return resolveSegment(segments, current) !== next;
};
