import { Ionicons } from "@expo/vector-icons";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useSegments } from "expo-router";
import { useCallback } from "react";
import { FlatList, View } from "react-native";
import { Text } from "@/components/common/Text";
import { getItemNavigation } from "@/components/common/TouchableItemRouter";
import { useAskForTitle } from "@/components/stingstream/requests/useAskForTitle";
import { TVPosterCard } from "@/components/tv/TVPosterCard";
import { useScaledTVPosterSizes, useScaledTVSizes } from "@/constants/TVSizes";
import { useScaledTVTypography } from "@/constants/TVTypography";
import useRouter from "@/hooks/useAppRouter";
import {
  type RequestSearchResult,
  requestCardId,
} from "@/lib/stingstream/requests";
import { scaleSize } from "@/utils/scaleSize";

/**
 * What pressing a title on a television does.
 *
 * A held title opens its own page. Everything else is asked for outright, with no picker and a
 * toast — `useAskForTitle`, the same contract `TVRequestButton` already makes and documents: a
 * D-pad is a bad instrument for a multi-select, so "all of it" is the honest default for a control
 * with no way to say otherwise, and everything it cannot do is a phone away.
 *
 * Shared by the row and by the filmography page, so a press means one thing on a television.
 */
export function useRequestablePress() {
  const router = useRouter();
  const segments = useSegments();
  const from = (segments as string[])[2] || "(home)";
  const { ask } = useAskForTitle();

  return useCallback(
    (result: RequestSearchResult) => {
      if (result.localItemId) {
        router.push(
          getItemNavigation(
            {
              Id: result.localItemId,
              Type: result.kind === "series" ? "Series" : "Movie",
            } as BaseItemDto,
            from,
          ) as never,
        );
        return;
      }

      void ask({
        tmdbId: result.tmdbId || undefined,
        tvdbId: result.tvdbId || undefined,
        title: result.title,
        year: result.year,
        posterUrl: result.posterUrl,
        overview: result.overview,
        seasonCount: result.seasonCount,
      });
    },
    [ask, from, router],
  );
}

/**
 * One poster on a television, for a title the library may or may not hold.
 *
 * **The plus is drawn at rest, not on focus, and that is the whole difference from the phone.**
 * `docs/conventions/tv.md` says focus is exactly one treatment — scale, a white border, a glow — and
 * giving it a second, semantic meaning on some cards and not others is the ambiguity that rule
 * exists to stop. A viewer scanning a row also needs to know which titles are askable *before*
 * landing on one, which a focus-keyed glyph cannot tell them. So rather than porting the phone's
 * hover onto focus, this stops keying off state at all. Dan, 2026-09-12.
 */
export const TVRequestableCard: React.FC<{
  result: RequestSearchResult;
  width: number;
  preferredFocus?: boolean;
  onFocus?: (result: RequestSearchResult) => void;
  /** Overrides the shared press. Omit for the ordinary play-or-ask behaviour. */
  onPress?: (result: RequestSearchResult) => void;
  /**
   * The played/favourite sheet, for a title this node actually holds.
   *
   * Only ever called for a held one: the sheet acts on a library item, and a title nobody has is
   * not one. A card with nothing to offer simply has no long press.
   */
  onLongPressHeld?: (itemId: string) => void;
}> = ({ result, width, preferredFocus, onFocus, onPress, onLongPressHeld }) => {
  const press = useRequestablePress();
  const held = Boolean(result.localItemId);

  // A held title is its real library item, so the card finds local artwork, progress and the
  // watched state the way every other poster on this screen does. A title nobody holds has none of
  // that and only a provider poster, which `imageUrlGetter` supplies.
  const item = {
    Id: held ? result.localItemId : requestCardId(result),
    Name: result.title,
    Type: result.kind === "series" ? "Series" : "Movie",
    ProductionYear: result.year,
  } as BaseItemDto;

  return (
    <View style={{ position: "relative" }}>
      <TVPosterCard
        item={item}
        orientation='vertical'
        width={width}
        showProgress={held}
        showWatchedIndicator={held}
        hasTVPreferredFocus={preferredFocus}
        imageUrlGetter={held ? undefined : () => result.posterUrl ?? undefined}
        onFocus={() => onFocus?.(result)}
        onPress={() => (onPress ?? press)(result)}
        onLongPress={
          held && result.localItemId && onLongPressHeld
            ? () => onLongPressHeld(result.localItemId as string)
            : undefined
        }
      />
      {held ? null : (
        <View
          pointerEvents='none'
          style={{
            position: "absolute",
            top: scaleSize(8),
            right: scaleSize(8),
            width: scaleSize(32),
            height: scaleSize(32),
            borderRadius: scaleSize(16),
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.65)",
          }}
        >
          <Ionicons name='add' size={scaleSize(20)} color='#FFFFFF' />
        </View>
      )}
    </View>
  );
};

/**
 * A row of titles on a television, whoever holds them.
 *
 * Laid out like `TVCastSection`: the same heading, the same horizontal bleed into the screen's own
 * padding, and no `hasTVPreferredFocus` unless the caller says so, since exactly one element per
 * screen may claim it.
 */
export const TVRequestableRow: React.FC<{
  title: string;
  results?: RequestSearchResult[];
  horizontalPadding: number;
  preferFocus?: boolean;
  onFocusResult?: (result: RequestSearchResult) => void;
}> = ({ title, results, horizontalPadding, preferFocus, onFocusResult }) => {
  const posterSizes = useScaledTVPosterSizes();
  const typography = useScaledTVTypography();
  const sizes = useScaledTVSizes();

  if (!results || results.length === 0) return null;

  return (
    <View style={{ marginBottom: sizes.gaps.section }}>
      <Text
        style={{
          fontSize: typography.heading,
          fontWeight: "600",
          color: "#FFFFFF",
          marginBottom: 24,
        }}
      >
        {title}
      </Text>
      <FlatList
        horizontal
        data={results}
        keyExtractor={requestCardId}
        showsHorizontalScrollIndicator={false}
        // A focused card scales past its own bounds; clipping would cut the focus ring off.
        removeClippedSubviews={false}
        style={{ marginHorizontal: -horizontalPadding, overflow: "visible" }}
        contentContainerStyle={{
          paddingHorizontal: horizontalPadding,
          gap: sizes.gaps.item,
        }}
        renderItem={({ item, index }) => (
          <TVRequestableCard
            result={item}
            width={posterSizes.poster}
            preferredFocus={preferFocus && index === 0}
            onFocus={onFocusResult}
          />
        )}
      />
    </View>
  );
};
