/**
 * Which section of Requests the route is asking for.
 *
 * No React in it, so `bun:test` can load it — the interesting part of a tab bar is which section
 * a URL selects, not how it is drawn. Same split, and the same reason, as `common/tabSegments.ts`,
 * whose `resolveSegment` does the narrowing here.
 */

import { resolveSegment, type Segment } from "@/components/common/tabSegments";
import type { RequestKind } from "@/lib/stingstream/requestsApi";

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

/** Every section the Requests screen can show. */
export type RequestSegmentKey =
  | "find"
  | "mine"
  | "alerts"
  | "approvals"
  | "wanted"
  | "activity"
  | "policy";

/**
 * Which sections this member sees, in order.
 *
 * Two things decide it. Only an administrator gets the last few at all, which has always been true.
 * And in a group where nobody has configured an indexer there is nothing to approve: approving
 * would authorise a download that is never going to start, so the approvals queue becomes a plain
 * list of what people want and the policy screen governing it disappears with it.
 *
 * Activity stays in both. It is the transfer and history view, which is a different question from
 * how a request is governed, and hiding more than was asked for is its own kind of surprise.
 *
 * A member's own three tabs are identical either way, deliberately: the mode changes what an
 * administrator does, not what anybody else sees.
 */
export const visibleRequestSegmentKeys = (
  canApprove: boolean,
  manual: boolean,
): RequestSegmentKey[] => {
  const mine: RequestSegmentKey[] = ["find", "mine", "alerts"];
  if (!canApprove) return mine;
  return manual
    ? [...mine, "wanted", "activity"]
    : [...mine, "approvals", "activity", "policy"];
};

/**
 * The kind chip a `?kind=` names, if it names a real one.
 *
 * Find opens on All, and an entry point that already knows what it is asking for says so on the
 * route: the empty state on a Movies library sends `kind=movie`, so the catalogue that greets the
 * reader is the one they were just looking at rather than everything the node can fetch.
 *
 * Narrowed here rather than cast at the call site, and `all` deliberately answers `undefined`
 * rather than itself: a stale link, a typo or a param naming the default all mean "nothing was
 * asked for", and Find seeds its own default from that.
 */
export const kindFromRoute = (
  kind: string | undefined,
): RequestKind | undefined =>
  kind === "movie" || kind === "series" ? kind : undefined;
