import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback, useMemo } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { Card } from "./Card";
import { autoGridColumns, type CardData, type CardKind } from "./CardData";
import { useCardLayout } from "./useCardLayout";
import { useItemCardBehavior } from "./useItemCardBehavior";

type Options = {
  items: BaseItemDto[];
  /**
   * Cards per row. Omit to fill the available width automatically: as many
   * columns of at least `gridMinCardWidth` as fit, the way CSS grid's
   * `auto-fill` would — so a browser resize changes the column count instead
   * of stretching a fixed number of cards across an arbitrary width.
   */
  columns?: number;
  kind?: CardKind;
  /**
   * Override the measured window width — a page whose content is capped by
   * `PageContainer` (a "media" page tops out at 1440 regardless of how wide
   * the browser window is) should compute columns from its own rendered
   * width, not the full window, or a wide monitor gets more columns than the
   * capped container actually has room for.
   */
  containerWidth?: number;
  /** Replaces the default navigation. */
  onPressItem?: (item: BaseItemDto) => void;
  /** Replaces the long-press action sheet. */
  onLongPressItem?: (item: BaseItemDto) => void;
  enableActionSheet?: boolean;
};

/**
 * The grid counterpart to `CardRow` — the same cards, laid out in columns.
 *
 * It hands back the pieces a list needs rather than a list of its own, so a
 * screen keeps its header, filters, paging and empty state and only borrows
 * the cells. Card width comes from the column count, since a grid fills the
 * screen where a row's cards are a fixed size.
 */
export function useCardGrid({
  items,
  columns: requestedColumns,
  kind = "portrait",
  containerWidth,
  onPressItem,
  onLongPressItem,
  enableActionSheet,
}: Options) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useCardLayout(kind);
  const { gutter } = useBreakpoint();
  const width = containerWidth ?? windowWidth;

  // The page's own gutter, not the kind's fixed inset — a grid's first and
  // last column line up with the page's other content at every width, the
  // way `CardRow` already does for a horizontal row.
  const available = width - insets.left - insets.right - gutter * 2;

  const columns = useMemo(() => {
    if (requestedColumns) return Math.max(requestedColumns, 1);
    return autoGridColumns(available, layout.gridMinCardWidth, layout.spacing);
  }, [requestedColumns, available, layout.spacing, layout.gridMinCardWidth]);

  const cardWidth = useMemo(() => {
    const usable = available - layout.spacing * (columns - 1);
    return Math.floor(usable / columns);
  }, [available, columns, layout.spacing]);

  const { cards, handlePress, handleLongPress, actionSheet } =
    useItemCardBehavior({
      items,
      kind,
      cardWidth,
      onPressItem,
      onLongPressItem,
      enableActionSheet,
    });

  // A library can mix poster art with square album art, and a grid row is as
  // tall as its tallest cell — so without a common height the short cards
  // leave ragged gaps. Reserve the tallest card's height for every cell and
  // let the shorter ones sit at the top of it. A grid of one shape (the usual
  // case) reserves exactly that shape and wastes nothing.
  const cellHeight = useMemo(() => {
    if (cards.length === 0) return cardWidth / layout.aspectRatio;
    // A smaller ratio is a taller card.
    const tallest = cards.reduce(
      (min, card) => Math.min(min, card.aspectRatio ?? layout.aspectRatio),
      Number.POSITIVE_INFINITY,
    );
    return cardWidth / tallest;
  }, [cards, cardWidth, layout.aspectRatio]);

  // A column is wider than the card it holds, so each card is nudged within
  // its column to land on the row inset and keep even gutters. Doing it here
  // rather than padding the list keeps a header spanning the full width.
  const columnOffset = useCallback(
    (index: number) => {
      const column = index % columns;
      return gutter + (column * (layout.spacing - gutter * 2)) / columns;
    },
    [columns, gutter, layout.spacing],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: CardData; index: number }) => (
      <View
        style={{
          width: "100%",
          height: cellHeight,
          paddingLeft: columnOffset(index),
        }}
      >
        <Card
          card={item}
          kind={kind}
          width={cardWidth}
          onPress={() => handlePress(item.id)}
          onLongPress={
            handleLongPress ? () => handleLongPress(item.id) : undefined
          }
        />
      </View>
    ),
    [cardWidth, cellHeight, columnOffset, kind, handlePress, handleLongPress],
  );

  const keyExtractor = useCallback((card: CardData) => card.id, []);

  return {
    /** Feed the list these instead of the raw items. */
    data: cards,
    renderItem,
    keyExtractor,
    /** Vertical gap between rows. */
    rowGap: layout.spacing,
    /**
     * The column count actually in use — the caller's own `columns` when
     * given, otherwise what the auto-fill formula picked for the current
     * width. Key a `FlashList`/`FlatList` on this: React Native does not
     * re-layout a list's `numColumns` on its own when the value changes, so a
     * browser resize that crosses a column boundary needs a remount to show it.
     */
    columns,
    /** Mount alongside the list; renders nothing until a long press. */
    actionSheet,
  };
}
