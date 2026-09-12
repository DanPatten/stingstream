import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useSegments } from "expo-router";
import { Fragment, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  useWindowDimensions,
  View,
  type ViewProps,
} from "react-native";
import { CardRow } from "@/components/cards/CardRow";
import { useCardGrid } from "@/components/cards/useCardGrid";
import { SectionHeader } from "@/components/common/SectionHeader";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import { maxWidth as MAX_WIDTHS } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import {
  type RequestSearchResult,
  requestCardId,
  toRequestableCard,
} from "@/lib/stingstream/requests";
import { RequestSheet } from "./RequestSheet";

/**
 * Cards, the press, and the sheet, for a list of catalogue results the library may or may not hold.
 *
 * Kept apart from the row so the grid gets all of it free, exactly the way `useItemCardBehavior` is
 * kept apart from `CardRow`.
 *
 * **A held title plays, everything else asks, and this is deliberately not what Find does.** On Find
 * every title opens the sheet, held ones included, because that screen is about asking. These rows
 * are library surfaces: a card carrying a play disc has to lead to the player, or the disc is a
 * promise the press does not keep.
 *
 * The press is decided by `localItemId`, the same field `requestHoverGlyph` reads, so the glyph and
 * what happens when you press it cannot disagree. A title the group holds but this node has not
 * materialised yet has no id, so it draws a plus and opens the sheet -- which says "your library
 * already has this", names the holder, and offers Play the moment an id resolves.
 */
function useRequestableCards(results: RequestSearchResult[] | undefined) {
  const { t } = useTranslation();
  const router = useRouter();
  const segments = useSegments();
  const from = (segments as string[])[2] || "(home)";
  const [picking, setPicking] = useState<RequestSearchResult | null>(null);

  const notInLibrary = t("item_card.not_in_library");

  const cards = useMemo(
    () =>
      (results ?? []).map((result) => toRequestableCard(result, notInLibrary)),
    [results, notInLibrary],
  );

  const byId = useMemo(
    () =>
      new Map((results ?? []).map((result) => [requestCardId(result), result])),
    [results],
  );

  const onPressId = useCallback(
    (id: string) => {
      const result = byId.get(id);
      if (!result) return;

      if (result.localItemId) {
        // Through the app's own router rather than a path written here, so a title opened from a
        // related row lands exactly where one opened from the library does.
        const target = getItemNavigation(
          {
            Id: result.localItemId,
            Type: result.kind === "series" ? "Series" : "Movie",
          } as BaseItemDto,
          from,
        );
        router.push(target as never);
        return;
      }

      setPicking(result);
    },
    [byId, from, router],
  );

  const close = useCallback(() => setPicking(null), []);

  return {
    cards,
    onPressId,
    /** Mount alongside the cards; renders nothing until one is pressed. */
    sheet: <RequestSheet result={picking} onClose={close} />,
  };
}

interface RowProps extends ViewProps {
  title: string;
  results?: RequestSearchResult[];
  loading: boolean;
}

/**
 * A horizontal row of titles, whoever holds them.
 *
 * No `enableActionSheet`: the long-press played/favourite sheet is items mode only, and these cards
 * stand for catalogue results rather than library items. A title the library holds still has its
 * own page, one press away, where all of that lives.
 *
 * **The corner badge is load-bearing and must not be dropped.** `toRequestCard` puts
 * `searchBadgeLabel` on every card, which draws "In library" over the artwork of the held ones. That
 * badge is the only signal on a touch screen, where there is no hover and so no disc at all, and it
 * is what makes a pointer-only glyph an enhancement rather than the only way to tell the two apart.
 * `docs/REQUESTS.md` §9 records a Request affordance that existed only under a pointer, and why that
 * failed.
 */
export const RequestableRow: React.FC<RowProps> = ({
  title,
  results,
  loading,
  ...props
}) => {
  const { cards, onPressId, sheet } = useRequestableCards(results);

  return (
    <View {...props}>
      <CardRow
        title={title}
        kind='portrait'
        cards={cards}
        loading={loading}
        hideIfEmpty
        onPressId={onPressId}
      />
      {sheet}
    </View>
  );
};

interface GridProps {
  /** Drawn above the grid, since the grid has no heading of its own. */
  title?: string;
  results?: RequestSearchResult[];
  loading: boolean;
}

/**
 * The same titles as a grid, for a screen whose whole body they are.
 *
 * The measuring is `RequestDiscoverGrid`'s, and for its reasons: the pane is narrower than the
 * window on web, and every poster URL carries the width it is drawn at, so a pass at the wrong width
 * asks the provider for every poster twice and leaves the ones below the fold blank.
 */
export const RequestableGrid: React.FC<GridProps> = ({
  title,
  results,
  loading,
}) => {
  const { gutter } = useBreakpoint();
  const { width: windowWidth } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const { cards, onPressId, sheet } = useRequestableCards(results);

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
    // Films and shows are mixed here, and which one a poster is decides whether the press ahead
    // asks for a film or for twenty seasons of something.
    kindGlyph: true,
    onPressId,
  });

  return (
    <View onLayout={measure}>
      {title ? <SectionHeader title={title} /> : null}
      {loading || paneWidth === null ? (
        <SkeletonGrid kind='portrait' columns={grid.columns} />
      ) : (
        <View
          testID='requestable-grid'
          style={{
            marginHorizontal: -gutter,
            flexDirection: "row",
            flexWrap: "wrap",
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
      {sheet}
    </View>
  );
};
