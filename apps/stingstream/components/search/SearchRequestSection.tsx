import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
} from "react-native";
import { Button } from "@/components/Button";
import { CardArtwork } from "@/components/cards/CardArtwork";
import {
  autoGridColumns,
  CARD_TEXT_GAP,
  CARD_TITLE_LINES,
} from "@/components/cards/CardData";
import { useCardLayout } from "@/components/cards/useCardLayout";
import { SkeletonGrid } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { maxWidth as MAX_WIDTHS, rgba } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { usePressableStates } from "@/hooks/usePressableStates";
import {
  type RequestSearchResult,
  requestTitle,
  searchAction,
  toRequestCard,
} from "@/lib/stingstream/requestsApi";
import { SearchSectionTitle } from "./SearchSectionTitle";

const isWeb = Platform.OS === "web";

/**
 * Enough to be worth scrolling, not enough to bury the library results above it.
 *
 * The node asks both arrs and hands back everything they matched, which for a common word is
 * dozens of near-identical sequels and re-releases. Eighteen divides by 2, 3 and 6 — the column
 * counts this grid actually uses — so the last row is full at every width the app is drawn at.
 */
const MAX_RESULTS = 18;

/** Fills the artwork; a hover affordance and the state wash both use it. */
const FILL = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/**
 * One catalogue result: a poster, its title and year, and — on web, under the pointer — the Request
 * button itself.
 *
 * Not `components/cards/Card`, although it is the same geometry, for one reason: that card's hover
 * state is a play glyph, and nothing in this section plays. A disc that says "press me to watch
 * this" on a film the server does not have is the one promise this screen must not make.
 *
 * Everywhere else the whole card is the affordance: a tap opens the sheet, which is where the
 * season picker, the "held by" notice and the real Request button live. The hover button is a
 * shortcut to the same sheet for a pointer that has somewhere to put itself, not a second route.
 */
function RequestResultCard({
  result,
  width,
  onPress,
}: {
  result: RequestSearchResult;
  width: number;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const layout = useCardLayout("portrait");
  const states = usePressableStates();
  const card = toRequestCard(result);
  const title = requestTitle(result);
  // `searchAction` is the same answer the sheet's own button gives, so a card never offers
  // something the sheet then refuses. A title already asked for carries the corner badge
  // `toRequestCard` put there ("Requested") and no button at all.
  const offered = !searchAction(result).disabled;
  const showRequest = isWeb && states.hovered && offered;

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={title}
      onPress={onPress}
      {...states.handlers}
      style={[{ width }, states.webStyle]}
    >
      <CardArtwork
        card={card}
        width={width}
        height={width / layout.aspectRatio}
        cornerRadius={layout.cornerRadius}
        overlay={
          <>
            {states.overlay ? (
              <View
                pointerEvents='none'
                style={[FILL, { backgroundColor: states.overlay }]}
              />
            ) : null}
            {showRequest ? (
              <View
                // `box-none` so the poster underneath still takes the press
                // everywhere the button itself is not.
                pointerEvents='box-none'
                style={[
                  FILL,
                  {
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: rgba("#000000", 0.55),
                  },
                ]}
              >
                <Button
                  testID='search-request-button'
                  variant='primary'
                  size='sm'
                  icon='requests'
                  onPress={onPress}
                  // Eighteen buttons all reading "Request" is eighteen controls
                  // with the same name; the title is what tells them apart.
                  accessibilityLabel={t("search.request_title", { title })}
                >
                  {t("search.request")}
                </Button>
              </View>
            ) : null}
          </>
        }
      />
      <View style={{ paddingTop: CARD_TEXT_GAP }}>
        <Text
          variant='caption'
          weight='medium'
          numberOfLines={CARD_TITLE_LINES}
        >
          {result.title}
        </Text>
        {result.year ? (
          <Text variant='micro' tone='secondary' numberOfLines={1}>
            {String(result.year)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * "Not in your library" — the second half of a search.
 *
 * It draws nothing at all when there is nothing to ask for. A server with no requests feature, a
 * node whose arrs are not configured, and a search that genuinely matched nothing new all end up
 * here with an empty list, and none of them is worth an empty box on a screen that has just shown
 * the user what it *did* find. The caller decides that by simply not rendering this.
 */
export function SearchRequestSection({
  results,
  loading,
  onPressResult,
}: {
  results: RequestSearchResult[];
  loading: boolean;
  onPressResult: (result: RequestSearchResult) => void;
}) {
  const { t } = useTranslation();
  const { gutter } = useBreakpoint();
  const layout = useCardLayout("portrait");
  const { width: windowWidth } = useWindowDimensions();
  const [measured, setMeasured] = useState(0);

  // Measured rather than assumed: at web-wide this section sits inside the shell's content pane,
  // which is the window minus the sidebar, so `useWindowDimensions()` alone would pick one column
  // too many and the last card in every row would be clipped. The window is only the first-paint
  // fallback, before `onLayout` has said anything.
  const width = measured || Math.min(windowWidth, MAX_WIDTHS.media);
  const available = Math.max(width - gutter * 2, layout.gridMinCardWidth);
  const columns = autoGridColumns(
    available,
    layout.gridMinCardWidth,
    layout.spacing,
  );
  const cardWidth = Math.floor(
    (available - layout.spacing * (columns - 1)) / columns,
  );

  // Rounded so a sub-pixel layout pass cannot set state to a "new" width every
  // frame; React bails out of a re-render only when the value is identical.
  const onLayout = (event: LayoutChangeEvent) =>
    setMeasured(Math.round(event.nativeEvent.layout.width));

  return (
    <View testID='search-request-section' onLayout={onLayout}>
      <SearchSectionTitle
        title={t("search.not_in_your_library")}
        detail={t("search.not_in_your_library_detail")}
      />

      {loading ? (
        <SkeletonGrid kind='portrait' columns={columns} rows={1} />
      ) : (
        <View
          testID='search-request-grid'
          style={{
            paddingHorizontal: gutter,
            flexDirection: "row",
            flexWrap: "wrap",
            gap: layout.spacing,
          }}
        >
          {results.slice(0, MAX_RESULTS).map((result) => (
            <RequestResultCard
              key={result.itemKey || toRequestCard(result).id}
              result={result}
              width={cardWidth}
              onPress={() => onPressResult(result)}
            />
          ))}
        </View>
      )}
    </View>
  );
}
