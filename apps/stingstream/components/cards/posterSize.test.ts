import { describe, expect, test } from "bun:test";
import { sizedPosterUrl } from "./posterSize";

// Pure string work, no react-native import anywhere in the chain, so unlike
// `cardLayout.test.ts` this needs no stub.

const TMDB = "https://image.tmdb.org/t/p/original/ej5C3rQSNXTU3khw5kCugnoA6OZ.jpg";
const TVDB_FLAT = "https://artworks.thetvdb.com/banners/posters/72955-1.jpg";
const TVDB_NESTED =
  "https://artworks.thetvdb.com/banners/series/387648/posters/5f59835ecdc21.jpg";

describe("sizedPosterUrl: TMDB", () => {
  test("a 56pt row poster on a 3x screen asks for w185", () => {
    // 56 * 3 = 168, and w185 is the smallest bucket that covers it. This is the
    // Requests row, and the case the whole module exists for: 218 KB -> 20 KB.
    expect(sizedPosterUrl(TMDB, 56, 3)).toBe(
      "https://image.tmdb.org/t/p/w185/ej5C3rQSNXTU3khw5kCugnoA6OZ.jpg",
    );
  });

  test("a 220pt details poster on a 2x screen asks for w500", () => {
    expect(sizedPosterUrl(TMDB, 220, 2)).toBe(
      "https://image.tmdb.org/t/p/w500/ej5C3rQSNXTU3khw5kCugnoA6OZ.jpg",
    );
  });

  test("a bucket is chosen when the target lands exactly on it", () => {
    // 185 exactly: the bucket that equals the target is big enough, and picking
    // the next one up would fetch 2.5x the bytes for nothing.
    expect(sizedPosterUrl(TMDB, 185, 1)).toContain("/t/p/w185/");
  });

  test("one pixel over a bucket moves up to the next", () => {
    expect(sizedPosterUrl(TMDB, 186, 1)).toContain("/t/p/w342/");
  });

  test("wider than the largest bucket falls back to original", () => {
    expect(sizedPosterUrl(TMDB, 1200, 2)).toContain("/t/p/original/");
  });

  test("an already-sized URL is rewritten, not left alone", () => {
    // The guard against matching on "original" only: a URL that has been
    // through this once must still resize correctly the next time.
    const sized = "https://image.tmdb.org/t/p/w780/abc.jpg";
    expect(sizedPosterUrl(sized, 56, 3)).toBe(
      "https://image.tmdb.org/t/p/w185/abc.jpg",
    );
  });

  test("is idempotent at the same size", () => {
    const once = sizedPosterUrl(TMDB, 56, 3);
    expect(sizedPosterUrl(once, 56, 3)).toBe(once);
  });

  test("a TMDB URL that is not an image path is left alone", () => {
    const odd = "https://image.tmdb.org/something/else.jpg";
    expect(sizedPosterUrl(odd, 56, 3)).toBe(odd);
  });
});

describe("sizedPosterUrl: TVDB", () => {
  test("a small poster takes the _t thumbnail", () => {
    // 156 KB -> 19 KB, measured.
    expect(sizedPosterUrl(TVDB_FLAT, 56, 3)).toBe(
      "https://artworks.thetvdb.com/banners/posters/72955-1_t.jpg",
    );
  });

  test("the nested banners/series shape works the same way", () => {
    expect(sizedPosterUrl(TVDB_NESTED, 56, 3)).toBe(
      "https://artworks.thetvdb.com/banners/series/387648/posters/5f59835ecdc21_t.jpg",
    );
  });

  test("a large poster keeps the full file", () => {
    // The _t variant is only ~210px wide, so a 220pt header poster would be
    // upscaled mush. There is no middle size to ask for.
    expect(sizedPosterUrl(TVDB_FLAT, 220, 2)).toBe(TVDB_FLAT);
  });

  test("_t is not doubled up", () => {
    const thumb = "https://artworks.thetvdb.com/banners/posters/72955-1_t.jpg";
    expect(sizedPosterUrl(thumb, 56, 3)).toBe(thumb);
  });

  test("_t is removed again when the same image is drawn large", () => {
    const thumb = "https://artworks.thetvdb.com/banners/posters/72955-1_t.jpg";
    expect(sizedPosterUrl(thumb, 220, 2)).toBe(TVDB_FLAT);
  });
});

describe("sizedPosterUrl: everything it must not touch", () => {
  test("Jellyfin's own image URLs pass through", () => {
    // These already carry fillWidth and are sized by the server. Rewriting them
    // here would be a second opinion fighting the first.
    const jf =
      "http://127.0.0.1:8801/jellyfin/Items/abc123/Images/Primary?fillWidth=400&quality=80&tag=xyz";
    expect(sizedPosterUrl(jf, 56, 3)).toBe(jf);
  });

  test("data URIs pass through", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(sizedPosterUrl(data, 56, 3)).toBe(data);
  });

  test("a relative path passes through", () => {
    expect(sizedPosterUrl("/local/poster.jpg", 56, 3)).toBe("/local/poster.jpg");
  });

  test("an unknown provider passes through", () => {
    const other = "https://example.com/t/p/original/poster.jpg";
    expect(sizedPosterUrl(other, 56, 3)).toBe(other);
  });

  test("null and undefined come back as null", () => {
    expect(sizedPosterUrl(null, 56, 3)).toBeNull();
    expect(sizedPosterUrl(undefined, 56, 3)).toBeNull();
    expect(sizedPosterUrl("", 56, 3)).toBeNull();
  });
});

describe("sizedPosterUrl: nonsense inputs", () => {
  test("a zero or negative width leaves the URL as given", () => {
    expect(sizedPosterUrl(TMDB, 0, 3)).toBe(TMDB);
    expect(sizedPosterUrl(TMDB, -10, 3)).toBe(TMDB);
  });

  test("a broken pixel ratio is treated as 1x rather than downgrading", () => {
    expect(sizedPosterUrl(TMDB, 300, Number.NaN)).toContain("/t/p/w342/");
    expect(sizedPosterUrl(TMDB, 300, 0)).toContain("/t/p/w342/");
  });
});
