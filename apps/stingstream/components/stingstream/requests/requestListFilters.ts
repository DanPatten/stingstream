/**
 * The filter bar over the request lists: My requests, and an administrator's Approvals or Wanted.
 *
 * No React in it, so `bun:test` can load it. The interesting parts of a filter bar are which rows a
 * choice keeps, what the chip says once it is chosen, and what a URL means, and none of those is
 * visible in a screenshot: a filter that quietly matched everything and one that quietly matched
 * nothing both look like a list.
 *
 * Not Discover's bar (`RequestFilterState` in `requestsApi.ts`). That one narrows a catalogue of
 * titles nobody has asked for yet, by genre, year and availability. These narrow a list of requests
 * people already made, by where each one got to, what kind of title it is and who asked.
 *
 * Client side, deliberately. `GET /requests` is not paged: it answers the whole list, which is a few
 * dozen rows, so narrowing what is already on screen is both instant and exact. If the endpoint is
 * ever paged, these want to become query params on it rather than a filter over one page.
 */

import {
  type MemberRequest,
  type RequestState,
  sameUser,
} from "@/lib/stingstream/requestsApi";

/** The sections that draw a request list, and so a filter bar. */
export type RequestListSection = "mine" | "approvals" | "wanted";

/** Every section key that has a bar. Activity is the transfer queue, not requests, so it has none. */
export const REQUEST_LIST_SECTIONS: readonly RequestListSection[] = [
  "mine",
  "approvals",
  "wanted",
];

export const isRequestListSection = (
  key: string | undefined,
): key is RequestListSection =>
  REQUEST_LIST_SECTIONS.includes(key as RequestListSection);

/**
 * Where a request got to, in four buckets rather than the store's seven states.
 *
 * Seven chips for seven states asked the reader to know the difference between approved and
 * fulfilling, which is a fact about the system, not about their request. The buckets are the
 * questions a person actually has: is somebody still to decide, is it on its way, is it here, and
 * did it not happen.
 */
export type RequestStatusFilter =
  | "all"
  | "waiting"
  | "in_progress"
  | "available"
  | "unsuccessful";

export type RequestTypeFilter = "all" | "movie" | "series";

export type RequestListSort = "newest" | "oldest" | "title";

export type RequestListDimension = "status" | "type" | "requester" | "sort";

export interface RequestListFilters {
  status: RequestStatusFilter;
  type: RequestTypeFilter;
  /** The `requestedBy` id of one member, or null for everyone. */
  requester: string | null;
  sort: RequestListSort;
}

export const DEFAULT_REQUEST_LIST_FILTERS: RequestListFilters = {
  status: "all",
  type: "all",
  requester: null,
  sort: "newest",
};

/**
 * Which store states each bucket covers. `wanted` is waiting: it is a manual node's pending, a
 * request nobody is searching for yet, and a member cannot tell the two apart from where they sit.
 */
export const STATUS_STATES: Record<
  Exclude<RequestStatusFilter, "all">,
  readonly RequestState[]
> = {
  waiting: ["pending", "wanted"],
  in_progress: ["approved", "fulfilling"],
  available: ["available"],
  unsuccessful: ["declined", "failed"],
};

export const STATUS_OPTIONS: readonly RequestStatusFilter[] = [
  "all",
  "waiting",
  "in_progress",
  "available",
  "unsuccessful",
];
export const TYPE_OPTIONS: readonly RequestTypeFilter[] = [
  "all",
  "movie",
  "series",
];
export const SORT_OPTIONS: readonly RequestListSort[] = [
  "newest",
  "oldest",
  "title",
];

/**
 * Which filters each section offers, in bar order.
 *
 * Only the ones that can narrow that list. Approvals and Wanted are already one state each (the
 * failed half of Approvals has its own heading), so a status chip there could only ever match all
 * or nothing. My requests is one member's own, so "Requested by" would have one name in it.
 */
export const REQUEST_LIST_DIMENSIONS: Record<
  RequestListSection,
  readonly RequestListDimension[]
> = {
  mine: ["status", "type", "sort"],
  approvals: ["type", "requester", "sort"],
  wanted: ["type", "requester", "sort"],
};

/** Anything narrowing or reordering the list, which is when Clear shows. */
export const requestListFiltersActive = (
  filters: RequestListFilters,
): boolean =>
  filters.status !== DEFAULT_REQUEST_LIST_FILTERS.status ||
  filters.type !== DEFAULT_REQUEST_LIST_FILTERS.type ||
  filters.requester !== DEFAULT_REQUEST_LIST_FILTERS.requester ||
  filters.sort !== DEFAULT_REQUEST_LIST_FILTERS.sort;

/** Whether one dimension has been moved off its default. What fills its chip. */
export const requestListDimensionActive = (
  dimension: RequestListDimension,
  filters: RequestListFilters,
): boolean => filters[dimension] !== DEFAULT_REQUEST_LIST_FILTERS[dimension];

const timeOf = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * The rows a filter keeps, in the order it asks for. Never mutates the input.
 *
 * Title order ignores case and accents, and falls back to newest first between two requests for
 * the same title, so the list does not shuffle between two identical renders.
 */
export const applyRequestListFilters = (
  rows: readonly MemberRequest[],
  filters: RequestListFilters,
): MemberRequest[] => {
  const states =
    filters.status === "all" ? null : STATUS_STATES[filters.status];
  const kept = rows.filter(
    (row) =>
      (states === null || states.includes(row.state)) &&
      (filters.type === "all" || row.kind === filters.type) &&
      (filters.requester === null ||
        sameUser(row.requestedBy, filters.requester)),
  );
  const newestFirst = (a: MemberRequest, b: MemberRequest) =>
    timeOf(b.requestedAt) - timeOf(a.requestedAt);
  switch (filters.sort) {
    case "oldest":
      return kept.sort((a, b) => -newestFirst(a, b));
    case "title":
      return kept.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
          newestFirst(a, b),
      );
    default:
      return kept.sort(newestFirst);
  }
};

/** One member who has a request in the list, for the "Requested by" picker. */
export interface RequesterOption {
  id: string;
  name: string;
}

/**
 * Everybody who asked for something in these rows, once each, by name.
 *
 * From the rows rather than the member list: a picker offering people with nothing in this list
 * offers choices that can only ever empty it.
 */
export const requesterOptions = (
  rows: readonly MemberRequest[],
): RequesterOption[] => {
  const seen: RequesterOption[] = [];
  for (const row of rows) {
    if (!row.requestedBy) continue;
    if (seen.some((option) => sameUser(option.id, row.requestedBy))) continue;
    seen.push({
      id: row.requestedBy,
      name: row.requestedByName || row.requestedBy,
    });
  }
  return seen.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
};

/** The route params a filtered list is written to. Short, because they are in an address bar. */
export interface RequestListParams {
  status?: string;
  type?: string;
  by?: string;
  sort?: string;
}

/** What is written to the route: every key present, `undefined` removing it. */
export interface WrittenRequestListParams {
  status: string | undefined;
  type: string | undefined;
  by: string | undefined;
  sort: string | undefined;
}

const pick = <T extends string>(
  options: readonly T[],
  value: string | undefined,
  fallback: T,
): T => (options.includes(value as T) ? (value as T) : fallback);

/**
 * The filters a URL names for a section.
 *
 * Only the dimensions that section offers are read, and an unknown value is the default rather than
 * an error: a stale link, a typo, or `?status=` carried onto Approvals should show a list, not an
 * empty one filtered by something there is no chip for.
 */
export const requestListFiltersFromParams = (
  section: RequestListSection,
  params: RequestListParams,
): RequestListFilters => {
  const dimensions = REQUEST_LIST_DIMENSIONS[section];
  const has = (dimension: RequestListDimension) =>
    dimensions.includes(dimension);
  const d = DEFAULT_REQUEST_LIST_FILTERS;
  return {
    status: has("status")
      ? pick(STATUS_OPTIONS, params.status, d.status)
      : d.status,
    type: has("type") ? pick(TYPE_OPTIONS, params.type, d.type) : d.type,
    requester: has("requester") && params.by ? params.by : d.requester,
    sort: has("sort") ? pick(SORT_OPTIONS, params.sort, d.sort) : d.sort,
  };
};

/**
 * The params to write for a section's filters: every key present, the defaults as `undefined`.
 *
 * Every key, so writing them over the current params clears whatever the last section left behind,
 * and defaults as `undefined`, so an unfiltered list keeps a clean `?tab=mine` address.
 */
export const requestListFiltersToParams = (
  filters: RequestListFilters | undefined,
): WrittenRequestListParams => {
  const f = filters ?? DEFAULT_REQUEST_LIST_FILTERS;
  const d = DEFAULT_REQUEST_LIST_FILTERS;
  return {
    status: f.status === d.status ? undefined : f.status,
    type: f.type === d.type ? undefined : f.type,
    by: f.requester === d.requester ? undefined : (f.requester ?? undefined),
    sort: f.sort === d.sort ? undefined : f.sort,
  };
};

/** A translator, narrowed to what the labels need, so tests can pass a stub. */
export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

/** The key naming each dimension, which is the chip's label while it is at its default. */
export const DIMENSION_LABEL_KEYS: Record<RequestListDimension, string> = {
  status: "requests.list_filter_status",
  type: "requests.list_filter_type",
  requester: "requests.list_filter_requester",
  sort: "library.filters.sort_by",
};

/** The label for one option of one dimension, as the picker lists it. */
export const requestListOptionLabel = (
  dimension: RequestListDimension,
  value: string,
  t: Translate,
  requesters: readonly RequesterOption[] = [],
): string => {
  switch (dimension) {
    case "status":
      return value === "all"
        ? t("requests.filter_kind_all")
        : t(`requests.list_status_${value}`);
    case "type":
      return value === "movie"
        ? t("requests.filter_kind_films")
        : value === "series"
          ? t("requests.filter_kind_series")
          : t("requests.filter_kind_all");
    case "requester":
      if (value === "") return t("requests.list_requester_everyone");
      return (
        requesters.find((option) => sameUser(option.id, value))?.name ??
        t("requests.list_requester_unknown")
      );
    default:
      return t(`requests.list_sort_${value}`);
  }
};

/**
 * What a chip reads: the dimension while it is at its default ("Status"), the dimension and its
 * value once something is chosen ("Status: Waiting"), so the bar says exactly what the list below
 * it is filtered by without opening anything.
 */
export const requestListChipLabel = (
  dimension: RequestListDimension,
  filters: RequestListFilters,
  t: Translate,
  requesters: readonly RequesterOption[] = [],
): string => {
  const name = t(DIMENSION_LABEL_KEYS[dimension]);
  if (!requestListDimensionActive(dimension, filters)) return name;
  const value = requestListOptionLabel(
    dimension,
    String(filters[dimension] ?? ""),
    t,
    requesters,
  );
  return t("requests.list_filter_applied", { dimension: name, value });
};
