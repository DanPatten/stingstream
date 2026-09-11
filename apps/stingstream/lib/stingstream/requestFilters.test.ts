import { describe, expect, it } from "bun:test";
import {
  applyRequestFilters,
  DEFAULT_REQUEST_FILTERS,
  discoverQuery,
  type RequestFilterState,
  type RequestSearchResult,
  requestFiltersActive,
} from "./requestsApi";

/**
 * The Find bar's rules, which are the same rules on both halves of the screen.
 *
 * Worth pinning here rather than leaving to the screen, because none of it is visible in a
 * screenshot: a filter that quietly matched everything and a filter that quietly matched nothing
 * both look like a list, and only one of them is what was pressed.
 */

const result = (
  over: Partial<RequestSearchResult> = {},
): RequestSearchResult => ({
  kind: "movie",
  title: "Blade Runner",
  year: 1982,
  overview: null,
  posterUrl: null,
  tmdbId: 78,
  tvdbId: 0,
  itemKey: "movie:tmdb:78",
  seasonCount: 0,
  genres: ["Science Fiction", "Drama"],
  rating: 8.1,
  popularity: 40,
  availableInGroup: false,
  holders: [],
  ...over,
});

const filters = (
  over: Partial<RequestFilterState> = {},
): RequestFilterState => ({
  ...DEFAULT_REQUEST_FILTERS,
  ...over,
});

describe("applyRequestFilters", () => {
  it("keeps everything when nothing is narrowing it", () => {
    const results = [result(), result({ itemKey: "movie:tmdb:2" })];

    expect(applyRequestFilters(results, filters())).toHaveLength(2);
  });

  it("narrows to one kind", () => {
    const results = [
      result(),
      result({ kind: "series", itemKey: "episode:tvdb:1:" }),
    ];

    const kept = applyRequestFilters(results, filters({ kind: "series" }));

    expect(kept.map((r) => r.kind)).toEqual(["series"]);
  });

  it("narrows by genre, whatever the casing", () => {
    const results = [
      result(),
      result({ itemKey: "movie:tmdb:2", genres: ["Comedy"] }),
    ];

    const kept = applyRequestFilters(results, filters({ genres: ["drama"] }));

    expect(kept.map((r) => r.itemKey)).toEqual(["movie:tmdb:78"]);
  });

  /**
   * A genre nothing carries must empty the list.
   *
   * The tempting shortcut is to ignore a filter that matches nothing, which reads to whoever
   * pressed it as the chip having done nothing at all.
   */
  it("empties the list for a genre nothing carries", () => {
    expect(
      applyRequestFilters([result()], filters({ genres: ["Western"] })),
    ).toEqual([]);
  });

  /** An older node sends no genres. That is "no genre", never "every genre". */
  it("never matches a result carrying no genres", () => {
    const bare = result({ genres: undefined });

    expect(applyRequestFilters([bare], filters({ genres: ["Drama"] }))).toEqual(
      [],
    );
    expect(applyRequestFilters([bare], filters())).toHaveLength(1);
  });

  it("narrows by year", () => {
    const results = [result(), result({ itemKey: "movie:tmdb:2", year: 1999 })];

    const kept = applyRequestFilters(results, filters({ years: ["1999"] }));

    expect(kept.map((r) => r.year)).toEqual([1999]);
  });

  it("narrows by what the group already has", () => {
    const held = result({ itemKey: "movie:tmdb:1", availableInGroup: true });
    const not = result({ itemKey: "movie:tmdb:2" });
    const asked = result({ itemKey: "movie:tmdb:3", requestState: "pending" });

    expect(
      applyRequestFilters(
        [held, not, asked],
        filters({ availability: ["held"] }),
      ),
    ).toEqual([held]);
    expect(
      applyRequestFilters(
        [held, not, asked],
        filters({ availability: ["not_held"] }),
      ),
    ).toEqual([not, asked]);
    expect(
      applyRequestFilters(
        [held, not, asked],
        filters({ availability: ["requested"] }),
      ),
    ).toEqual([asked]);
  });

  /**
   * The default sort leaves the answer alone.
   *
   * A search's own order is relevance. Sorting by popularity the moment the screen opens would push
   * the show somebody typed the name of below a dozen movies that outrank it.
   */
  it("does not reorder under the default sort", () => {
    const first = result({ itemKey: "movie:tmdb:1", popularity: 1 });
    const second = result({ itemKey: "movie:tmdb:2", popularity: 99 });

    expect(applyRequestFilters([first, second], filters())).toEqual([
      first,
      second,
    ]);
  });

  it("sorts by rating, best first, and reverses on ascending", () => {
    const good = result({ itemKey: "movie:tmdb:1", rating: 9 });
    const poor = result({ itemKey: "movie:tmdb:2", rating: 3 });

    expect(
      applyRequestFilters([poor, good], filters({ sortBy: ["top_rated"] })).map(
        (r) => r.rating,
      ),
    ).toEqual([9, 3]);
    expect(
      applyRequestFilters(
        [poor, good],
        filters({ sortBy: ["top_rated"], sortOrder: ["asc"] }),
      ).map((r) => r.rating),
    ).toEqual([3, 9]);
  });

  it("sorts by release and by title", () => {
    const old = result({ itemKey: "movie:tmdb:1", title: "Alpha", year: 1970 });
    const recent = result({
      itemKey: "movie:tmdb:2",
      title: "Zulu",
      year: 2020,
    });

    expect(
      applyRequestFilters([old, recent], filters({ sortBy: ["newest"] })).map(
        (r) => r.year,
      ),
    ).toEqual([2020, 1970]);
    expect(
      applyRequestFilters(
        [old, recent],
        filters({ sortBy: ["title"], sortOrder: ["asc"] }),
      ).map((r) => r.title),
    ).toEqual(["Alpha", "Zulu"]);
  });
});

describe("requestFiltersActive", () => {
  /** A bar that opens with Clear showing is a bar offering to undo something nobody did. */
  it("is false at the defaults", () => {
    expect(requestFiltersActive(DEFAULT_REQUEST_FILTERS)).toBe(false);
  });

  it("is true once anything at all has been chosen", () => {
    expect(requestFiltersActive(filters({ kind: "movie" }))).toBe(true);
    expect(requestFiltersActive(filters({ genres: ["Drama"] }))).toBe(true);
    expect(requestFiltersActive(filters({ years: ["1999"] }))).toBe(true);
    expect(requestFiltersActive(filters({ availability: ["held"] }))).toBe(
      true,
    );
    expect(requestFiltersActive(filters({ sortBy: ["top_rated"] }))).toBe(true);
    expect(requestFiltersActive(filters({ sortOrder: ["asc"] }))).toBe(true);
  });
});

describe("discoverQuery", () => {
  it("asks for the popular first page by default", () => {
    expect(discoverQuery(DEFAULT_REQUEST_FILTERS)).toEqual({
      sort: "popular",
      order: "desc",
      page: "1",
    });
  });

  /** An empty chip must not become an empty parameter the node then has to interpret. */
  it("leaves out what has not been chosen", () => {
    const query = discoverQuery(filters({ genres: [], years: [] }));

    expect(query.kind).toBeUndefined();
    expect(query.genres).toBeUndefined();
    expect(query.year).toBeUndefined();
  });

  it("carries the chosen kind, genres, year and page", () => {
    const query = discoverQuery(
      filters({
        kind: "series",
        genres: ["Drama", "Comedy"],
        years: ["1999"],
        sortBy: ["top_rated"],
        sortOrder: ["asc"],
      }),
      2,
    );

    expect(query).toEqual({
      kind: "series",
      genres: "Drama,Comedy",
      year: "1999",
      sort: "top_rated",
      order: "asc",
      page: "2",
    });
  });
});
