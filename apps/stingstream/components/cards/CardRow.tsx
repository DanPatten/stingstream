import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { Icon } from "@/components/common/Icon";
import { SectionHeader } from "@/components/common/SectionHeader";
import { Text } from "@/components/common/Text";
import { rgba, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { Card } from "./Card";
import {
  type CardData,
  type CardKind,
  type CardSlots,
  cardRowHeight,
  cardTextBlockHeight,
  defaultTextPlacement,
} from "./CardData";
import { CardRowSkeleton } from "./CardRowSkeleton";
import { useCardLayout } from "./useCardLayout";
import { useItemCardBehavior } from "./useItemCardBehavior";

interface Props extends ViewProps {
  /** Section heading. Omit for a bare row. */
  title?: string | null;
  /** Renders a "See all" action next to the title. */
  onPressSeeAll?: () => void;
  seeAllLabel?: string;
  kind?: CardKind;

  /** Media items — cards, navigation and the action sheet are handled here. */
  items?: BaseItemDto[];
  /** Prebuilt cards, for anything that isn't a `BaseItemDto` (cast members). */
  cards?: CardData[];

  /** Prefer the episode's own still over the series thumbnail. */
  useEpisodePoster?: boolean;
  /** Item to keep at full opacity; every other card is faded back. */
  selectedId?: string | null;
  /** Card to scroll into view when this value changes. */
  scrollToId?: string | null;

  /**
   * Where each card's title goes. Defaults to the kind's own answer — see
   * `defaultTextPlacement`. Pass it only to override that.
   */
  textPlacement?: "over" | "below";
  /** Per-card extras — see `CardSlots`. Memoize at the call site. */
  slots?: Pick<CardSlots, "overlay" | "footer">;
  /**
   * Height to reserve under each card's artwork — a horizontal list is given
   * one height per cell and cannot measure the text inside it.
   *
   * Omit it and the row reserves exactly the title block a below-the-artwork
   * card draws (two title lines and a subtitle, `cardTextBlockHeight`). A row
   * whose `slots.footer` adds lines of its own passes the total for the whole
   * block, text included, since only that caller knows how tall its footer is.
   */
  footerHeight?: number;

  loading?: boolean;
  /** Spinner after the last card while the next page loads. */
  loadingMore?: boolean;
  onEndReached?: () => void;
  /** Shown in place of the row when there is nothing to draw. */
  emptyText?: string;
  /** Renders nothing at all when the row is empty. */
  hideIfEmpty?: boolean;

  /** Replaces the default navigation (items mode). */
  onPressItem?: (item: BaseItemDto) => void;
  /** Press handler for `cards` mode. */
  onPressId?: (id: string) => void;
  /** Replaces the long-press action sheet (items mode). */
  onLongPressItem?: (item: BaseItemDto) => void;
  /** Long-press handler for `cards` mode. */
  onLongPressId?: (id: string) => void;
  /** Drawn at the end of the heading — a count pill, a small action. */
  headerAccessory?: React.ReactNode;
  /**
   * Long press opens the played/favorite sheet (items mode). Off by default —
   * a row only gets it where the screen it replaced had it, so converting a
   * row never adds an affordance behind the user's back.
   */
  enableActionSheet?: boolean;
}

const isWeb = Platform.OS === "web";

/**
 * A horizontal row of media cards — the one component every section uses.
 *
 * It draws the heading, the loading skeleton, the empty state and the cards
 * themselves, so a section only has to say which items it wants shown.
 */
export const CardRow: React.FC<Props> = ({
  title,
  onPressSeeAll,
  seeAllLabel,
  kind = "wide",
  items,
  cards: providedCards,
  useEpisodePoster = false,
  selectedId,
  scrollToId,
  textPlacement,
  slots,
  footerHeight,
  loading = false,
  loadingMore = false,
  onEndReached,
  emptyText,
  hideIfEmpty = false,
  onPressItem,
  onPressId,
  onLongPressItem,
  onLongPressId,
  headerAccessory,
  enableActionSheet = false,
  ...props
}) => {
  const layout = useCardLayout(kind);
  const { name: breakpoint, gutter, isWebWide } = useBreakpoint();
  const { accent } = useTheme();
  // The page's own gutter, not the kind's fixed inset — so a row's first and
  // last card line up with the section title above it and the page's other
  // content at every width, the way `PageContainer`/`SectionHeader` already do.
  const contentInset = gutter;

  const placement = textPlacement ?? defaultTextPlacement(kind);
  const belowArtwork =
    footerHeight ??
    (placement === "below" ? cardTextBlockHeight(breakpoint) : 0);

  const { cards, handlePress, handleLongPress, actionSheet } =
    useItemCardBehavior({
      items,
      cards: providedCards,
      kind,
      useEpisodePoster,
      selectedId,
      cardWidth: layout.cardWidth,
      onPressItem,
      onPressId,
      onLongPressItem,
      onLongPressId,
      enableActionSheet,
    });

  const listRef = useRef<FlashListRef<CardData>>(null);
  // Every card is the same width, so a card always sits at a multiple of this
  // — both for snapping and for bringing one into view.
  const stride = layout.cardWidth + layout.spacing;

  // Scrolling before the list has measured is silently ignored, so the request
  // waits for the first content-size report rather than for a timeout.
  const [isMeasured, setIsMeasured] = useState(false);
  const handleContentSizeChange = useCallback((width: number) => {
    if (width > 0) setIsMeasured(true);
  }, []);

  // Only act on a *change* of scrollToId, so bringing a card into view never
  // fights the user's own scrolling on an unrelated re-render.
  const scrolledToId = useRef<string | null>(null);
  useEffect(() => {
    if (!isMeasured || !scrollToId || scrollToId === scrolledToId.current)
      return;
    const index = cards.findIndex((card) => card.id === scrollToId);
    // The cards may not have arrived yet; this runs again when they do.
    if (index < 0) return;
    scrolledToId.current = scrollToId;
    listRef.current?.scrollToOffset({ offset: index * stride, animated: true });
  }, [isMeasured, scrollToId, cards, stride]);

  // Observed on web: a horizontal row can settle with its scroll position
  // pinned at the far end (scrollLeft === scrollWidth - clientWidth) on first
  // paint, with no `scrollToId` request and no user input involved — a row
  // several screens down the page, sized identically to a sibling row that
  // opens correctly, opened already scrolled past its own first card. The
  // browser's own scroll anchoring re-adjusting an off-screen scroller as its
  // images load in and shift its layout is the leading suspect, and
  // `overflow-anchor` is the CSS escape hatch for exactly that — but it is
  // not an inherited property, so it has to land on the actual scrolling DOM
  // node (`getScrollableNode()`), not a wrapper `style` prop, which react-
  // native-web resolves to a different element than the one with `overflow-x:
  // auto`. Claiming the start position once as well, the same way `scrollToId`
  // claims a destination, covers whatever this misses.
  const homed = useRef(false);
  useEffect(() => {
    if (!isMeasured || scrollToId || homed.current) return;
    homed.current = true;
    const node = isWeb
      ? (listRef.current?.getScrollableNode?.() as HTMLElement | undefined)
      : undefined;
    if (node?.style) {
      node.style.overflowAnchor = "none";
      // `scrollToOffset` goes through FlashList's own scroll-to machinery,
      // which was observed silently failing to correct this exact case —
      // setting the DOM scrollLeft directly, confirmed to hold once set, is
      // the reliable path on web.
      node.scrollLeft = 0;
    } else {
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
  }, [isMeasured, scrollToId]);

  // Web-wide row-end arrows: hover the row, get a "page" left/right instead
  // of hunting for the scrollbar. `viewportWidth` is measured because the row
  // doesn't otherwise know how many cards actually fit on screen at once.
  const [rowHovered, setRowHovered] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const scrollOffsetRef = useRef(0);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollOffsetRef.current = event.nativeEvent.contentOffset.x;
    },
    [],
  );
  const handleListLayout = useCallback((event: LayoutChangeEvent) => {
    setViewportWidth(event.nativeEvent.layout.width);
  }, []);
  const scrollByPage = useCallback(
    (direction: 1 | -1) => {
      const visible = Math.max(1, Math.floor(viewportWidth / stride));
      const next = Math.max(
        0,
        scrollOffsetRef.current + visible * stride * direction,
      );
      listRef.current?.scrollToOffset({ offset: next, animated: true });
    },
    [viewportWidth, stride],
  );

  const renderCard = useCallback(
    ({ item }: { item: CardData }) => (
      <Card
        card={item}
        kind={kind}
        textPlacement={placement}
        slots={slots}
        onPress={() => handlePress(item.id)}
        onLongPress={
          handleLongPress ? () => handleLongPress(item.id) : undefined
        }
      />
    ),
    [kind, placement, slots, handlePress, handleLongPress],
  );

  const isEmpty = cards.length === 0;
  if (hideIfEmpty && isEmpty && !loading) return null;

  const showArrows = isWeb && isWebWide && !loading && !isEmpty;

  return (
    <View {...props}>
      {Boolean(title) && (
        <SectionHeader
          title={title as string}
          actionLabel={seeAllLabel}
          actionDisabled={loading}
          onPressAction={onPressSeeAll}
          accessory={headerAccessory}
        />
      )}

      {loading ? (
        <CardRowSkeleton kind={kind} />
      ) : isEmpty ? (
        emptyText ? (
          <View className='px-4'>
            <Text className='text-neutral-500'>{emptyText}</Text>
          </View>
        ) : null
      ) : (
        <Pressable
          onHoverIn={() => setRowHovered(true)}
          onHoverOut={() => setRowHovered(false)}
          onLayout={handleListLayout}
          style={[
            {
              height: cardRowHeight(layout, belowArtwork),
              position: "relative",
            },
            // `overflow-anchor: none` on an ancestor suppresses scroll
            // anchoring for the whole subtree, not just the element it's set
            // on — belt and braces alongside the same style on the FlashList
            // itself, since which DOM node is the actual scroll container is
            // an implementation detail of the list library.
            isWeb ? ({ overflowAnchor: "none" } as ViewStyle) : null,
          ]}
        >
          <FlashList
            ref={listRef}
            data={cards}
            renderItem={renderCard}
            keyExtractor={(card) => card.id}
            horizontal
            // The browser's own scroll anchoring can re-adjust an off-screen
            // horizontal scroller's position as its images load in and shift
            // its layout — observed pinning a below-the-fold row at its
            // maximum scroll on first paint, with no request or interaction
            // involved. `overflow-anchor` is exactly the escape hatch for
            // this; ignored on native.
            style={isWeb ? ({ overflowAnchor: "none" } as ViewStyle) : null}
            showsHorizontalScrollIndicator={false}
            // Settle on a card rather than drifting to an arbitrary offset.
            snapToInterval={stride}
            snapToAlignment='start'
            decelerationRate='fast'
            onScroll={handleScroll}
            scrollEventThrottle={16}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.5}
            onContentSizeChange={handleContentSizeChange}
            ItemSeparatorComponent={() => (
              <View style={{ width: layout.spacing }} />
            )}
            ListFooterComponent={
              loadingMore ? (
                <View
                  style={{
                    width: 48,
                    height: "100%",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ActivityIndicator size='small' color={accent[500]} />
                </View>
              ) : null
            }
            contentContainerStyle={{
              paddingHorizontal: contentInset,
              paddingVertical: layout.verticalPadding,
            }}
          />

          {showArrows && (
            <>
              <RowArrow
                direction='left'
                visible={rowHovered}
                inset={contentInset}
                bottom={belowArtwork}
                onPress={() => scrollByPage(-1)}
              />
              <RowArrow
                direction='right'
                visible={rowHovered}
                inset={contentInset}
                bottom={belowArtwork}
                onPress={() => scrollByPage(1)}
              />
            </>
          )}
        </Pressable>
      )}

      {actionSheet}
    </View>
  );
};

/** One end of a web-wide row: a translucent disc that appears on row hover. */
const RowArrow: React.FC<{
  direction: "left" | "right";
  visible: boolean;
  inset: number;
  /** Room under the artwork the arrow should stay clear of, so it centres on
   * the posters rather than on the posters-plus-their-titles. */
  bottom: number;
  onPress: () => void;
}> = ({ direction, visible, inset, bottom, onPress }) => {
  const sidePosition: ViewStyle =
    direction === "left" ? { left: inset / 2 } : { right: inset / 2 };

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={direction === "left" ? "Scroll left" : "Scroll right"}
      onPress={onPress}
      pointerEvents={visible ? "auto" : "none"}
      style={[
        {
          position: "absolute",
          top: 0,
          bottom,
          width: 36,
          alignItems: "center",
          justifyContent: "center",
          opacity: visible ? 1 : 0,
          ...sidePosition,
        },
        { transitionDuration: `${tokens.motion.fast}ms` } as ViewStyle,
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: rgba("#000000", 0.55),
        }}
      >
        <Icon
          name={direction === "left" ? "chevronLeft" : "chevronRight"}
          size={18}
          color='#FFFFFF'
        />
      </View>
    </Pressable>
  );
};
