import { describe, expect, it } from "bun:test";
import type { MemberRequest } from "@/lib/stingstream/requestsApi";
import en from "@/translations/en.json";
import {
  applyRequestListFilters,
  DEFAULT_REQUEST_LIST_FILTERS,
  DIMENSION_LABEL_KEYS,
  REQUEST_LIST_DIMENSIONS,
  type RequestListFilters,
  requesterOptions,
  requestListChipLabel,
  requestListFiltersActive,
  requestListFiltersFromParams,
  requestListFiltersToParams,
  requestListOptionLabel,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type Translate,
} from "./requestListFilters";

const request = (over: Partial<MemberRequest> = {}): MemberRequest => ({
  id: "1",
  group: "g",
  kind: "movie",
  itemKey: "movie:tmdb:1",
  provider: "tmdb",
  providerId: 1,
  title: "Alien",
  seasons: [],
  state: "pending",
  requestedBy: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  requestedByName: "Dan",
  requestedAt: "2026-09-01T10:00:00Z",
  note: "",
  mine: true,
  updatedAt: "2026-09-01T10:00:00Z",
  ...over,
});

const filters = (
  over: Partial<RequestListFilters> = {},
): RequestListFilters => ({
  ...DEFAULT_REQUEST_LIST_FILTERS,
  ...over,
});

/** The real English catalogue, so a missing key or a changed word fails here. */
const t: Translate = (key, options) => {
  const found = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      en,
    );
  if (typeof found !== "string") throw new Error(`missing key ${key}`);
  return found.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    String(options?.[name] ?? ""),
  );
};

const ids = (rows: MemberRequest[]) => rows.map((row) => row.id);

describe("applyRequestListFilters", () => {
  const rows = [
    request({ id: "p", state: "pending", requestedAt: "2026-09-03T00:00:00Z" }),
    request({ id: "w", state: "wanted", requestedAt: "2026-09-01T00:00:00Z" }),
    request({ id: "a", state: "approved", kind: "series", title: "Dark" }),
    request({ id: "f", state: "fulfilling", title: "Blade Runner" }),
    request({ id: "v", state: "available", title: "Cube" }),
    request({ id: "d", state: "declined", kind: "series", title: "Fargo" }),
    request({ id: "x", state: "failed", title: "Heat" }),
  ];

  it("keeps everything with nothing narrowing it", () => {
    expect(applyRequestListFilters(rows, filters())).toHaveLength(rows.length);
  });

  it("buckets the store's states into four", () => {
    const pick = (status: RequestListFilters["status"]) =>
      ids(applyRequestListFilters(rows, filters({ status }))).sort();
    expect(pick("waiting")).toEqual(["p", "w"]);
    expect(pick("in_progress")).toEqual(["a", "f"]);
    expect(pick("available")).toEqual(["v"]);
    expect(pick("unsuccessful")).toEqual(["d", "x"]);
  });

  it("narrows by type", () => {
    expect(
      ids(applyRequestListFilters(rows, filters({ type: "series" }))).sort(),
    ).toEqual(["a", "d"]);
  });

  it("matches a requester whatever the id's dashes", () => {
    const mixed = [
      request({ id: "1", requestedBy: "aaaaaaaabbbbccccddddeeeeeeeeeeee" }),
      request({ id: "2", requestedBy: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ];
    expect(
      ids(
        applyRequestListFilters(
          mixed,
          filters({ requester: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
        ),
      ),
    ).toEqual(["1"]);
  });

  it("combines every filter", () => {
    expect(
      ids(
        applyRequestListFilters(
          rows,
          filters({ status: "unsuccessful", type: "movie" }),
        ),
      ),
    ).toEqual(["x"]);
  });

  it("sorts newest, oldest and by title, without touching the input", () => {
    const three = [
      request({
        id: "old",
        title: "beta",
        requestedAt: "2026-01-01T00:00:00Z",
      }),
      request({
        id: "new",
        title: "Alpha",
        requestedAt: "2026-03-01T00:00:00Z",
      }),
      request({
        id: "mid",
        title: "Gamma",
        requestedAt: "2026-02-01T00:00:00Z",
      }),
    ];
    const before = ids(three);
    expect(ids(applyRequestListFilters(three, filters()))).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect(
      ids(applyRequestListFilters(three, filters({ sort: "oldest" }))),
    ).toEqual(["old", "mid", "new"]);
    expect(
      ids(applyRequestListFilters(three, filters({ sort: "title" }))),
    ).toEqual(["new", "old", "mid"]);
    expect(ids(three)).toEqual(before);
  });
});

describe("requesterOptions", () => {
  it("lists each member once, by name", () => {
    const options = requesterOptions([
      request({ requestedBy: "b1", requestedByName: "zoe" }),
      request({ requestedBy: "a1", requestedByName: "Adam" }),
      request({ requestedBy: "b1", requestedByName: "zoe" }),
      request({ requestedBy: "", requestedByName: "" }),
    ]);
    expect(options).toEqual([
      { id: "a1", name: "Adam" },
      { id: "b1", name: "zoe" },
    ]);
  });
});

describe("sections", () => {
  it("offers no status where the list is already one state, and no requester on your own", () => {
    expect(REQUEST_LIST_DIMENSIONS.mine).toEqual(["status", "type", "sort"]);
    expect(REQUEST_LIST_DIMENSIONS.approvals).not.toContain("status");
    expect(REQUEST_LIST_DIMENSIONS.wanted).not.toContain("status");
    expect(REQUEST_LIST_DIMENSIONS.approvals).toContain("requester");
  });
});

describe("route params", () => {
  it("round-trips a section's filters", () => {
    const chosen = filters({ status: "waiting", type: "movie", sort: "title" });
    expect(
      requestListFiltersFromParams("mine", requestListFiltersToParams(chosen)),
    ).toEqual(chosen);
  });

  it("writes every key, defaults as undefined, so the last section's are cleared", () => {
    expect(requestListFiltersToParams(undefined)).toEqual({
      status: undefined,
      type: undefined,
      by: undefined,
      sort: undefined,
    });
    expect(requestListFiltersToParams(filters({ requester: "u1" })).by).toBe(
      "u1",
    );
  });

  it("ignores junk and dimensions the section does not offer", () => {
    expect(
      requestListFiltersFromParams("mine", {
        status: "nonsense",
        by: "u1",
        sort: "sideways",
      }),
    ).toEqual(DEFAULT_REQUEST_LIST_FILTERS);
    expect(
      requestListFiltersFromParams("approvals", {
        status: "waiting",
        by: "u1",
      }),
    ).toEqual(filters({ requester: "u1" }));
  });
});

describe("chip labels", () => {
  it("names the dimension while it is at its default", () => {
    for (const dimension of ["status", "type", "requester", "sort"] as const) {
      expect(requestListChipLabel(dimension, filters(), t)).toBe(
        t(DIMENSION_LABEL_KEYS[dimension]),
      );
    }
  });

  it("carries the value once one is chosen", () => {
    expect(
      requestListChipLabel("status", filters({ status: "waiting" }), t),
    ).toBe("Status: Waiting");
    expect(requestListChipLabel("type", filters({ type: "series" }), t)).toBe(
      "Type: TV shows",
    );
    expect(requestListChipLabel("sort", filters({ sort: "oldest" }), t)).toBe(
      "Sort by: Oldest first",
    );
    expect(
      requestListChipLabel("requester", filters({ requester: "u1" }), t, [
        { id: "u1", name: "Dan" },
      ]),
    ).toBe("Requested by: Dan");
  });

  it("has a label for every option, and a fallback for a member no longer listed", () => {
    for (const value of STATUS_OPTIONS) {
      expect(requestListOptionLabel("status", value, t)).toBeTruthy();
    }
    for (const value of SORT_OPTIONS) {
      expect(requestListOptionLabel("sort", value, t)).toBeTruthy();
    }
    expect(requestListOptionLabel("requester", "", t)).toBe("Everyone");
    expect(requestListOptionLabel("requester", "gone", t)).toBe(
      "Unknown member",
    );
  });

  it("counts as active only when something moved off its default", () => {
    expect(requestListFiltersActive(filters())).toBe(false);
    expect(requestListFiltersActive(filters({ sort: "title" }))).toBe(true);
    expect(requestListFiltersActive(filters({ requester: "u1" }))).toBe(true);
  });
});
