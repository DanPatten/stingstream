import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type RequestSearchResult,
  toRequestCard,
} from "@/lib/stingstream/requests";
import { RequestPosterGrid } from "./RequestPosterGrid";

interface Props {
  results: RequestSearchResult[];
  loading: boolean;
  onPress: (result: RequestSearchResult) => void;
}

/**
 * The catalogue as posters.
 *
 * A grid rather than the rows a search answers with, and the two are different on purpose. A
 * search for a common word is a dozen sequels and re-releases whose posters are near-identical, so
 * the overview is the only thing that tells them apart. A curated feed is the opposite: it is
 * sixty titles that have nothing to do with each other, nobody reads sixty blurbs, and the poster
 * is how anyone recognises a movie at a glance.
 *
 * Pressing a poster does exactly what pressing a row's button does, which is why the handler comes
 * in from the screen rather than living here. A title must not mean one thing as a tile and
 * another as a row.
 *
 * The grid itself is `RequestPosterGrid`, shared with the line of the member's own requests above
 * it, so the two sit in the same columns.
 */
export const RequestDiscoverGrid: React.FC<Props> = ({
  results,
  loading,
  onPress,
}) => {
  const { t } = useTranslation();

  const byId = useMemo(
    () => new Map(results.map((result) => [result.itemKey, result])),
    [results],
  );

  // The year, and how long the show is when the catalogue knows: a run of twenty seasons is the
  // difference between "I'll start that tonight" and "not this year", and it is the one thing a
  // poster never says. A movie has no season count and gets the year alone.
  const cards = useMemo(
    () =>
      results.map((result) => {
        const card = toRequestCard(result);
        const seasons = result.seasonCount ?? 0;
        if (seasons <= 0) return card;
        return {
          ...card,
          subtitle: [
            card.subtitle,
            t("requests.season_count", { count: seasons }),
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }),
    [results, t],
  );

  return (
    <RequestPosterGrid
      cards={cards}
      loading={loading}
      testID='requests-grid'
      cardTestID='requests-card'
      // Movies and shows are mixed on one grid here, and which one a poster is decides whether the
      // press ahead asks for a movie or for twenty seasons of something.
      kindGlyph
      onPressId={(id) => {
        const result = byId.get(id);
        if (result) onPress(result);
      }}
    />
  );
};
