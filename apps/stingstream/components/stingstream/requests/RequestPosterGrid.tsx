import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import type { CardData } from "@/components/cards/CardData";
import { useCardGrid } from "@/components/cards/useCardGrid";
import { useCardLayout } from "@/components/cards/useCardLayout";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";

interface Props {
  cards: CardData[];
  loading: boolean;
  onPressId: (id: string) => void;
  /**
   * Draw at most this many lines of the grid. Omit for all of them.
   *
   * When the cards do not fit, the last cell becomes a "+N more" tile rather than a poster cut off
   * at the edge: a clipped poster reads as a layout fault, and a count says there is more and how
   * much. The tile is drawn only when `onMore` is given, since a tile that goes nowhere is worse
   * than a line that simply ends.
   */
  lines?: number;
  /** Where the "+N more" tile goes. */
  onMore?: () => void;
  testID: string;
  cardTestID: string;
  /** Draws each card's movie or show glyph — see `Card`. */
  kindGlyph?: boolean;
}

/**
 * Requests' posters as a grid: the catalogue on Discover, and the line of the member's own requests
 * above it.
 *
 * One component for both so the two cannot disagree about where a column is. The line of requests
 * used to be a horizontal `CardRow`, whose posters are a fixed size of their own, and it sat out of
 * step with the catalogue under it at every width.
 */
export function RequestPosterGrid({
  cards,
  loading,
  onPressId,
  lines,
  onMore,
  testID,
  cardTestID,
  kindGlyph = false,
}: Props) {
  const { gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

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
    cardTestID,
    // Nobody holds these titles yet, so nothing here plays. A play disc on hover would be a
    // promise the press does not keep: it opens the request sheet.
    hoverPlayGlyph: false,
    kindGlyph,
    onPressId,
  });

  const capacity = lines ? grid.columns * lines : grid.data.length;
  const overflowing = Boolean(onMore) && grid.data.length > capacity;
  // One cell fewer when the tile needs the last one, so the tile sits where the next poster would.
  const shown = grid.data.slice(
    0,
    overflowing ? Math.max(capacity - 1, 0) : capacity,
  );
  const hidden = grid.data.length - shown.length;

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
        <SkeletonGrid kind='portrait' columns={grid.columns} rows={lines} />
      ) : (
        <View
          testID={testID}
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
          {shown.map((item, index) => (
            <Fragment key={item.id}>
              {grid.renderItem({ item, index })}
            </Fragment>
          ))}
          {overflowing && onMore ? (
            <View
              style={{
                width: grid.cell.width,
                flexGrow: 0,
                flexShrink: 0,
                height: grid.cell.height,
              }}
            >
              <View
                style={{ marginLeft: grid.cell.columnOffset(shown.length) }}
              >
                <MoreTile
                  count={hidden}
                  width={grid.cell.cardWidth}
                  onPress={onMore}
                  testID={`${testID}-more`}
                />
              </View>
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** A poster-sized tile saying how many more there are. Its own component so the hook always runs. */
function MoreTile({
  count,
  width,
  onPress,
  testID,
}: {
  count: number;
  width: number;
  onPress: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const { color } = useTheme();
  const layout = useCardLayout("portrait");
  const states = usePressableStates();
  const label = t("requests.more_count", { count });

  return (
    <Pressable
      testID={testID}
      accessibilityRole='button'
      accessibilityLabel={label}
      onPress={onPress}
      {...states.handlers}
      style={[
        {
          width,
          height: width / layout.aspectRatio,
          borderRadius: layout.cornerRadius,
          borderWidth: 1,
          borderColor: color.border.strong,
          backgroundColor: color.bg["1"],
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        },
        states.webStyle,
      ]}
    >
      {states.overlay ? (
        <View
          pointerEvents='none'
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: states.overlay,
          }}
        />
      ) : null}
      <Text variant='heading' weight='semibold'>
        {label}
      </Text>
    </Pressable>
  );
}
