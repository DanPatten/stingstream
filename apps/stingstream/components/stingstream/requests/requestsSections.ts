/**
 * Which section of Requests the route is asking for.
 *
 * No React in it, so `bun:test` can load it — the interesting part of a tab bar is which section
 * a URL selects, not how it is drawn. Same split, and the same reason, as `common/tabSegments.ts`,
 * whose `resolveSegment` does the narrowing here.
 */

import { resolveSegment, type Segment } from "@/components/common/tabSegments";

/**
 * What a bare `/requests` opens on.
 *
 * Not Find, although Find is the first tab in the bar: somebody who opens Requests without naming
 * a section is checking on what they already asked for. Landing on Find is always deliberate —
 * the tab itself, or the `?tab=find` that Search's `Request "…"` button hands over.
 */
export const DEFAULT_REQUEST_SECTION = "mine";

/** The one section that answers a term, and so the one a `?q=` implies. */
const TERM_SECTION = "find";

/**
 * The section to show, from the route params and the sections this member actually has.
 *
 * The section is *route* state rather than component state, which is the whole point: a reload, a
 * bookmark, a link pasted to somebody else and a return to the page all read the URL back, and six
 * sections sharing one address can answer none of them. It stays flat — one param on one route
 * rather than a nested navigator — for the reason `Tabs` gives: these are sections of one page,
 * and a stack here would put a back step between two halves of the same errand. Pressing a tab is
 * therefore a `setParams`, which react-navigation's web linking turns into a `history.replace`
 * (the route count is unchanged): the address bar follows the section, Back still leaves Requests
 * rather than walking its sections, and the entry it leaves behind remembers the last one open.
 *
 * `term` decides only when `tab` is silent. Somebody who arrives with a title on the route is
 * asking for it, and Find is the only section that can answer; once they press a tab the param is
 * written and it is their choice that counts, not the term they arrived with.
 *
 * `resolveSegment` does the rest, so a section this member cannot see — `?tab=policy` after a
 * demotion, a stale link, a typo — falls back to a real one instead of leaving the bar with
 * nothing selected above a screen with nothing on it.
 */
export const sectionFromRoute = (
  segments: readonly Segment[],
  tab: string | undefined,
  term = "",
): string =>
  resolveSegment(
    segments,
    tab || (term.trim() ? TERM_SECTION : DEFAULT_REQUEST_SECTION),
  ) ?? DEFAULT_REQUEST_SECTION;
