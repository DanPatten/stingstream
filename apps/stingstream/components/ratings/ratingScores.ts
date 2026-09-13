/**
 * The rules for a title's scores, wherever they are drawn: the details page of something the
 * library holds, a Requests tile, a request row, the request sheet. Pure, so `RatingChips` and the
 * grid that reserves room for it (`cardScoresLineHeight`) read the same geometry, and so the rules
 * are tested without a React tree.
 *
 * Two scores, whatever the source: a community score out of ten, drawn as a star, and a critics'
 * percentage, drawn as a tomato. The library gets them from Jellyfin (`CommunityRating`,
 * `CriticRating`), Requests from IMDb and Rotten Tomatoes through the node. Dan: *"Use stars instead
 * of IMDB. Make sure this logic is unified and shared between the library and request versions."*
 */

/** The star's gold. A score colour rather than a theme colour: the same in all three themes. */
export const RATING_STAR_COLOR = "#E0B34A";

/** Rotten Tomatoes' own line between a fresh tomato and a splat. */
export const FRESH_FROM = 60;

export type RatingChipSize = "micro" | "caption";

/** `micro` sits under a poster, `caption` on a row, a sheet or a details page. */
export const RATING_CHIP_GEOMETRY: Record<
  RatingChipSize,
  {
    paddingHorizontal: number;
    paddingVertical: number;
    glyph: number;
    gap: number;
  }
> = {
  micro: { paddingHorizontal: 6, paddingVertical: 1, glyph: 10, gap: 6 },
  caption: { paddingHorizontal: 8, paddingVertical: 3, glyph: 13, gap: 8 },
};

/** A title's scores as they arrive. Null or undefined is "no score". */
export type RatingScores = {
  /** Out of ten. */
  community?: number | null;
  /** A percentage. */
  critics?: number | null;
};

export type VisibleRatings = {
  /** One decimal, ready to draw. */
  community: string | null;
  critics: { score: number; fresh: boolean } | null;
};

/**
 * Which scores get drawn, and how.
 *
 * A missing score is hidden rather than drawn as a dash or a zero. Zero counts as missing too: a
 * provider answers 0 for a title nobody has voted on, and "0.0" or "0%" reads as a verdict.
 */
export const visibleRatings = ({
  community,
  critics,
}: RatingScores): VisibleRatings => ({
  community: community != null && community > 0 ? community.toFixed(1) : null,
  critics:
    critics != null && critics > 0
      ? { score: Math.round(critics), fresh: critics >= FRESH_FROM }
      : null,
});

/** Whether there is anything to draw at all. A caller with nothing drops the line and its spacing. */
export const hasRatings = (scores: RatingScores): boolean => {
  const shown = visibleRatings(scores);
  return shown.community !== null || shown.critics !== null;
};
