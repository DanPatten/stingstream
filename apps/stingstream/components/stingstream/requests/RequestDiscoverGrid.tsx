import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  useWindowDimensions,
  View,
} from "react-native";
import { useCardGrid } from "@/components/cards/useCardGrid";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  type RequestSearchResult,
  toRequestCard,
} from "@/lib/stingstream/requests";

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
 */
export const RequestDiscoverGrid: React.FC<Props> = ({
  results,
  loading,
  onPress,
}) => {
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

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

  /*
   * The width this grid actually got, measured.
   *
   * It used to be `min(window, media) + gutter * 2`, which is the width `PageContainer` would
   * render at *if the page were the window* — and on web it never is: the shell's sidebar and the
   * page's own margins take a couple of hundred pixels off it. So the grid sized itself for eight
   * columns while the pane had room for five, and since the cell offsets cycle on the column count
   * rather than on how many actually fit per line, every row started at a different inset. Three
   * rows, three left edges, none of them the page's own.
   *
   * The window is only the first guess, for the frame before the layout pass answers.
   */
  const containerWidth =
    (paneWidth ?? Math.min(windowWidth, MAX_WIDTHS.media)) + gutter * 2;

  const measure = (event: LayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.width;
    setPaneWidth((current) => (current === measured ? current : measured));
  };

  const grid = useCardGrid({
    cards,
    kind: "portrait",
    containerWidth,
    cardTestID: "requests-card",
    // Nobody holds these titles yet, so nothing here plays. A play disc on hover would be a
    // promise the press does not keep: it opens the request sheet.
    hoverPlayGlyph: false,
    // Movies and shows are mixed on one grid here, and which one a poster is decides whether the
    // press ahead asks for a movie or for twenty seasons of something.
    kindGlyph: true,
    onPressId: (id) => {
      const result = byId.get(id);
      if (result) onPress(result);
    },
  });

  // The measured element is this outer view rather than the row itself: the row bleeds into the
  // page gutter with a negative margin, so its own width is the answer plus the thing being
  // asked about. This one is exactly the pane.
  //
  // Nothing real is drawn until it has answered. Rendering the guess first and correcting it a
  // frame later is not free here: every card's poster URL carries the width it is drawn at
  // (`sizedPosterUrl`), so a pass at the wrong width asks the metadata provider for sixty posters
  // at one size and then sixty more at another, and the ones below the fold sit on the first,
  // never-loaded request looking like blank tiles.
  return (
    <View onLayout={measure}>
      {loading || paneWidth === null ? (
        <SkeletonGrid kind='portrait' columns={grid.columns} />
      ) : (
        <View
          testID='requests-grid'
          style={{
            marginHorizontal: -gutter,
            flexDirection: "row",
            flexWrap: "wrap",
            // The list screens pass this as a `FlashList` separator; a wrapping
            // row takes it directly. Without it the rows touched, and a card's
            // year sat flush against the poster on the row below.
            rowGap: grid.rowGap,
          }}
        >
          {grid.data.map((item, index) => (
            <Fragment key={item.id}>
              {grid.renderItem({ item, index })}
            </Fragment>
          ))}
        </View>
      )}
    </View>
  );
};
