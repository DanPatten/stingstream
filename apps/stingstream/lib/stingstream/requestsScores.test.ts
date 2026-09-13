import { describe, expect, test } from "bun:test";
import {
  cardScores,
  createScoresBatcher,
  requestAsSearchResult,
  rottenTomatoesUrl,
  scoresFor,
  scoresKey,
  scoresQueryOf,
  type TitleScores,
  type TitleScoresQuery,
  toRequest,
  toRequestCard,
  toSearchResult,
  toTitleScores,
} from "./requestsApi";

const lost = toSearchResult({
  Kind: "series",
  Title: "Lost",
  Year: 2004,
  TvdbId: 73739,
  ImdbId: "tt0411008",
  ItemKey: "episode:tvdb:73739:",
});

describe("title scores", () => {
  test("reads either casing", () => {
    const pascal = toTitleScores({
      ImdbId: "tt0133093",
      ImdbRating: 8.7,
      RottenTomatoesScore: 83,
      RottenTomatoesUrl: "https://www.rottentomatoes.com/m/matrix",
    });
    const camel = toTitleScores({
      imdbId: "tt0133093",
      imdbRating: 8.7,
      rottenTomatoesScore: 83,
      rottenTomatoesUrl: "https://www.rottentomatoes.com/m/matrix",
    });
    expect(pascal).toEqual(camel);
    expect(pascal.imdbRating).toBe(8.7);
    expect(pascal.rottenTomatoesScore).toBe(83);
  });

  test("a request asks by the one id it stored", () => {
    const request = toRequest({
      Id: "r1",
      Kind: "movie",
      Provider: "tmdb",
      ProviderId: 603,
      Title: "The Matrix",
      Year: 1999,
    });
    expect(scoresQueryOf(request)).toEqual({
      kind: "movie",
      tmdbId: 603,
      tvdbId: 0,
      imdbId: null,
      title: "The Matrix",
      year: 1999,
    });
  });

  test("a request and the search result it came from share one cache entry", () => {
    const request = toRequest({
      Id: "r2",
      Kind: "series",
      Provider: "tvdb",
      ProviderId: 73739,
      Title: "Lost",
      Year: 2004,
    });
    expect(scoresKey(scoresQueryOf(request))).toBe(
      scoresKey(scoresQueryOf(lost)),
    );
    // The sheet opened from My requests reads the same scores as the card behind it.
    expect(scoresKey(scoresQueryOf(requestAsSearchResult(request)))).toBe(
      scoresKey(scoresQueryOf(request)),
    );
  });

  test("a missing score is a dash, not a zero", () => {
    expect(cardScores(undefined)).toEqual({ imdb: null, rottenTomatoes: null });
    expect(cardScores({ imdbRating: 8.2, rottenTomatoesScore: 0 })).toEqual({
      imdb: 8.2,
      rottenTomatoes: 0,
    });
  });

  test("looks a title up by its own key", () => {
    const map = new Map<string, TitleScores>([
      [scoresKey(scoresQueryOf(lost)), { imdbRating: 8.3 }],
    ]);
    expect(scoresFor(map, lost)?.imdbRating).toBe(8.3);
  });

  test("the Rotten Tomatoes link falls back to a search", () => {
    expect(
      rottenTomatoesUrl({
        title: "Lost",
        rottenTomatoesUrl: "https://www.rottentomatoes.com/tv/lost",
      }),
    ).toBe("https://www.rottentomatoes.com/tv/lost");
    expect(rottenTomatoesUrl({ title: "Blade Runner 2049" })).toBe(
      "https://www.rottentomatoes.com/search?search=Blade%20Runner%202049",
    );
  });

  test("a Requests card no longer carries TMDB's star", () => {
    expect(toRequestCard({ ...lost, rating: 8.1 }).rating).toBeUndefined();
  });
});

describe("createScoresBatcher", () => {
  const query = (title: string): TitleScoresQuery => ({
    kind: "movie",
    tmdbId: 1,
    tvdbId: 0,
    title,
  });

  test("asks in the same moment go out as one call, answered in order", async () => {
    const calls: string[][] = [];
    const load = createScoresBatcher(
      async (titles) => {
        calls.push(titles.map((t) => t.title));
        return titles.map((t) => ({ imdbRating: t.title.length }));
      },
      { wait: 1 },
    );

    const [a, b, c] = await Promise.all([
      load(query("A")),
      load(query("BB")),
      load(query("CCC")),
    ]);

    expect(calls).toEqual([["A", "BB", "CCC"]]);
    expect([a.imdbRating, b.imdbRating, c.imdbRating]).toEqual([1, 2, 3]);
  });

  test("splits a big page into calls the node accepts", async () => {
    const sizes: number[] = [];
    const load = createScoresBatcher(
      async (titles) => {
        sizes.push(titles.length);
        return titles.map(() => ({}));
      },
      { wait: 1, size: 2 },
    );

    await Promise.all(["a", "b", "c", "d", "e"].map((t) => load(query(t))));

    expect(sizes).toEqual([2, 2, 1]);
  });

  test("a failed call fails its own asks and no others", async () => {
    let call = 0;
    const load = createScoresBatcher(
      async (titles) => {
        call += 1;
        if (call === 1) throw new Error("down");
        return titles.map(() => ({ imdbRating: 7 }));
      },
      { wait: 1, size: 1 },
    );

    const results = await Promise.allSettled([
      load(query("first")),
      load(query("second")),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
  });

  test("a short answer resolves the rest as no scores rather than hanging", async () => {
    const load = createScoresBatcher(async () => [{ imdbRating: 9 }], {
      wait: 1,
    });

    const [first, second] = await Promise.all([
      load(query("one")),
      load(query("two")),
    ]);

    expect(first.imdbRating).toBe(9);
    expect(second).toEqual({});
  });
});
