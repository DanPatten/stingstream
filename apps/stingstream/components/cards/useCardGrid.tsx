import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useCallback, useMemo } from "react";
import { useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { Card } from "./Card";
import {
  autoGridColumns,
  type CardData,
  type CardKind,
  cardTextBlockHeight,
  defaultTextPlacement,
} from "./CardData";
import { useCardLayout } from "./useCardLayout";
import { useItemCardBehavior } from "./useItemCardBehavior";

type Options = {
  /** Media items — cards are built here, and presses navigate. */
  items?: BaseItemDto[];
  /** Prebuilt cards, for anything that isn't a `BaseItemDto` (a Requests search result). */
  cards?: CardData[];
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
  /** Replaces the default navigation (items mode). */
  onPressItem?: (item: BaseItemDto) => void;
  /** Press handler for `cards` mode. */
  onPressId?: (id: string) => void;
  /** Replaces the long-press action sheet (items mode). */
  onLongPressItem?: (item: BaseItemDto) => void;
  /** Long-press handler for `cards` mode. */
  onLongPressId?: (id: string) => void;
  enableActionSheet?: boolean;
  /**
   * What each cell answers to in a screenshot sweep.
   *
   * Defaulted rather than required: every existing grid is `library-card` and the sweep's selectors
   * name it. Requests passes its own, because its pinned route looks for `requests-card` and a
   * shared default would have made the new grid invisible to the sweep rather than wrong.
   */
  cardTestID?: string;
  /**
   * Whether hovering a card draws the play disc — see `Card`. Off for a grid
   * whose cards do not lead to a player.
   */
  hoverPlayGlyph?: boolean;
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
  cards: providedCards,
  columns: requestedColumns,
  kind = "portrait",
  containerWidth,
  onPressItem,
  onPressId,
  onLongPressItem,
  onLongPressId,
  enableActionSheet,
  cardTestID,
  hoverPlayGlyph,
}: Options) {
  const { width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useCardLayout(kind);
  const { name: breakpoint, gutter } = useBreakpoint();
  const width = containerWidth ?? windowWidth;

  // What the list itself is given to lay columns out in — the container minus
  // the safe area, before the page gutter is taken out of it. Each cell is
  // exactly this wide divided by the column count, stated rather than left to
  // `flex: 1`: a last row holding fewer cards than there are columns would
  // otherwise stretch its cells across the whole row and leave a ragged gap
  // where the missing cards should be.
  const listWidth = width - insets.left - insets.right;

  // The page's own gutter, not the kind's fixed inset — a grid's first and
  // last column line up with the page's other content at every width, the
  // way `CardRow` already does for a horizontal row.
  const available = listWidth - gutter * 2;

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
      cards: providedCards,
      kind,
      cardWidth,
      onPressItem,
      onPressId,
      onLongPressItem,
      onLongPressId,
      enableActionSheet,
    });

  // Room under the artwork for the title block, when this kind puts its title
  // there — the same reservation `CardRow` makes, for the same reason: the
  // cell is given a height before the text inside it has been measured.
  const belowArtwork =
    defaultTextPlacement(kind) === "below"
      ? cardTextBlockHeight(breakpoint)
      : 0;

  // A library can mix poster art with square album art, and a grid row is as
  // tall as its tallest cell — so without a common height the short cards
  // leave ragged gaps. Reserve the tallest card's height for every cell and
  // let the shorter ones sit at the top of it. A grid of one shape (the usual
  // case) reserves exactly that shape and wastes nothing.
  const cellHeight = useMemo(() => {
    if (cards.length === 0)
      return cardWidth / layout.aspectRatio + belowArtwork;
    // A smaller ratio is a taller card.
    const tallest = cards.reduce(
      (min, card) => Math.min(min, card.aspectRatio ?? layout.aspectRatio),
      Number.POSITIVE_INFINITY,
    );
    return cardWidth / tallest + belowArtwork;
  }, [cards, cardWidth, layout.aspectRatio, belowArtwork]);

  // A column is wider than the card it holds, so each card is nudged within
  // its column to land on the row inset and keep even gutters. Doing it here
  // rather than padding the list keeps a header spanning the full width.
  //
  // The nudge goes *negative* past the middle of the row and has to: the
  // columns tile the whole list width, gutters included, while the cards they
  // hold are pitched `cardWidth + spacing` apart, which is the narrower step
  // whenever the page gutter is wider than half the card spacing — always, at
  // every breakpoint we ship. So the last card sits a little to the left of its
  // own column, and lands exactly on the page's right gutter.
  //
  // It is a margin rather than padding for that reason alone: a negative
  // `paddingLeft` is invalid, and both web and Yoga drop it to zero without a
  // word, which is what left the right-hand columns of every grid drifting
  // wider apart than the left-hand ones.
  const columnOffset = useCallback(
    (index: number) => {
      const column = index % columns;
      return gutter + (column * (layout.spacing - gutter * 2)) / columns;
    },
    [columns, gutter, layout.spacing],
  );

  const columnWidth = listWidth / columns;

  const renderItem = useCallback(
    ({ item, index }: { item: CardData; index: number }) => (
      <View
        style={{
          // Stated, not `flex: 1`: a last row of two cards in a four-column
          // grid must sit under the first two columns, not spread itself
          // across the width of four.
          width: columnWidth,
          flexGrow: 0,
          flexShrink: 0,
          height: cellHeight,
        }}
      >
        <View style={{ marginLeft: columnOffset(index) }}>
          <Card
            card={item}
            kind={kind}
            width={cardWidth}
            testID={cardTestID}
            hoverPlayGlyph={hoverPlayGlyph}
            onPress={() => handlePress(item.id)}
            onLongPress={
              handleLongPress ? () => handleLongPress(item.id) : undefined
            }
          />
        </View>
      </View>
    ),
    [
      cardWidth,
      cardTestID,
      cellHeight,
      columnWidth,
      columnOffset,
      hoverPlayGlyph,
      kind,
      handlePress,
      handleLongPress,
    ],
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
