import { Fragment, useMemo, useState } from "react";
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
 * is how anyone recognises a film at a glance.
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
  const { gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

  const byId = useMemo(
    () => new Map(results.map((result) => [result.itemKey, result])),
    [results],
  );
  const cards = useMemo(() => results.map(toRequestCard), [results]);

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
    onPressId: (id) => {
      const result = byId.get(id);
      if (result) onPress(result);
    },
  });

  // The measured element is this outer view rather than the row itself: the row bleeds into the
  // page gutter with a negative margin, so its own width is the answer plus the thing being
  // asked about. This one is exactly the pane.
  return (
    <View onLayout={measure}>
      {loading ? (
        <SkeletonGrid kind='portrait' columns={grid.columns} />
      ) : (
        <View
          testID='requests-grid'
          style={{
            marginHorizontal: -gutter,
            flexDirection: "row",
            flexWrap: "wrap",
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
