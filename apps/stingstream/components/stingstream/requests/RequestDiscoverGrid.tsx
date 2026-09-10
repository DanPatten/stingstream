import { Fragment, useMemo } from "react";
import { useWindowDimensions, View } from "react-native";
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

  const byId = useMemo(
    () => new Map(results.map((result) => [result.itemKey, result])),
    [results],
  );
  const cards = useMemo(() => results.map(toRequestCard), [results]);

  // The same width `PageContainer width="media"` renders at, measured rather than assumed: this
  // screen sits inside the web shell's sidebar and top bar, whose content pane is not the width of
  // the browser window, so `useWindowDimensions()` alone overcounts on a wide browser.
  const containerWidth = Math.min(windowWidth, MAX_WIDTHS.media) + gutter * 2;

  const grid = useCardGrid({
    cards,
    kind: "portrait",
    containerWidth,
    cardTestID: "requests-card",
    onPressId: (id) => {
      const result = byId.get(id);
      if (result) onPress(result);
    },
  });

  if (loading) {
    return <SkeletonGrid kind='portrait' columns={grid.columns} />;
  }

  return (
    <View
      testID='requests-grid'
      style={{
        marginHorizontal: -gutter,
        flexDirection: "row",
        flexWrap: "wrap",
      }}
    >
      {grid.data.map((item, index) => (
        <Fragment key={item.id}>{grid.renderItem({ item, index })}</Fragment>
      ))}
    </View>
  );
};
