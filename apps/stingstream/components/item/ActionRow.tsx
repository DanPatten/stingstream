import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, type StyleProp, View, type ViewStyle } from "react-native";
import { Button } from "@/components/Button";
import { Icon, type IconName } from "@/components/common/Icon";
import { PlayButton } from "@/components/PlayButton";
import {
  WatchlistSheet,
  type WatchlistSheetRef,
} from "@/components/watchlists/WatchlistSheet";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useFavorite } from "@/hooks/useFavorite";
import { useMarkAsPlayed } from "@/hooks/useMarkAsPlayed";
import { useTheme } from "@/hooks/useTheme";
import {
  useItemInWatchlists,
  useStreamystatsEnabled,
} from "@/hooks/useWatchlists";
import { useSettings } from "@/utils/atoms/settings";
import type { SelectedOptions } from "../ItemContent";
import { MoreMenu, type MoreMenuAction } from "./MoreMenu";

interface Props {
  item: BaseItemDto;
  /**
   * What Play actually plays, when that is not `item` itself: a series has no
   * file of its own, so its button plays the next episode you have not
   * finished. Every other control still acts on `item`.
   */
  playItem?: BaseItemDto | null;
  /** Absent while the play settings are still resolving; Play waits. */
  selectedOptions?: SelectedOptions;
  /** Rows for the "…" menu, assembled by the page that owns the data. */
  moreActions?: MoreMenuAction[];
  /**
   * The "..." itself, for a picker one of its rows opens: it drops from the same place the menu
   * did. The page owns the ref when it owns such a picker.
   */
  moreAnchorRef?: RefObject<View | null>;
  /** Press Play as soon as it can. See `PlayButton`'s own `autoPlay`. */
  autoPlay?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** `Button` size `lg`, which Play is. */
const PLAY_BUTTON_HEIGHT = 52;

/**
 * Play, and the six things you might do instead.
 *
 * One primary and the rest as ghosts, because a row where everything is filled
 * is a row where nothing is primary — the pass-02 page had a white-outlined
 * "0m" bar and a circle of the same weight beside it and no way to tell which
 * one started the movie.
 *
 * Every control here carries an `accessibilityLabel` even when it also carries a
 * word, and the icon-only ones carry nothing else (F-24): the accessibility
 * snapshot of this page has no unnamed buttons in it.
 */
export const ActionRow: React.FC<Props> = ({
  item,
  playItem,
  selectedOptions,
  moreActions = [],
  moreAnchorRef,
  autoPlay = false,
  style,
}) => {
  const { t } = useTranslation();
  const { isCompact } = useBreakpoint();
  const { accent } = useTheme();
  const { settings } = useSettings();
  const [moreOpen, setMoreOpen] = useState(false);
  const ownAnchor = useRef<View>(null);
  const moreAnchor = moreAnchorRef ?? ownAnchor;

  const { isFavorite, toggleFavorite } = useFavorite(item);
  const togglePlayed = useMarkAsPlayed(useMemo(() => [item], [item]));
  const played = Boolean(item.UserData?.Played);

  const streamystatsEnabled = useStreamystatsEnabled();
  const watchlistSheet = useRef<WatchlistSheetRef>(null);
  const { data: watchlists } = useItemInWatchlists(item.Id);
  const inWatchlist = (watchlists?.length ?? 0) > 0;
  const showWatchlist = streamystatsEnabled && !settings.hideWatchlistsTab;

  const trailerUrl = item.RemoteTrailers?.[0]?.Url;
  const openTrailer = useCallback(() => {
    if (trailerUrl) void Linking.openURL(trailerUrl);
  }, [trailerUrl]);

  return (
    <View style={style}>
      <View
        style={{
          flexDirection: isCompact ? "column" : "row",
          // Top-aligned, so a progress rule and caption under Play hang below the row rather
          // than pushing the icons down to the middle of the column. Wraps rather than
          // squeezing Play, whose label is never truncated.
          alignItems: isCompact ? "stretch" : "flex-start",
          flexWrap: isCompact ? "nowrap" : "wrap",
          gap: 12,
        }}
      >
        {selectedOptions && (playItem ?? item) ? (
          <PlayButton
            item={(playItem ?? item) as BaseItemDto}
            selectedOptions={selectedOptions}
            fullWidth={isCompact}
            autoPlay={autoPlay}
            style={isCompact ? undefined : { minWidth: 200 }}
          />
        ) : null}

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 8,
            // The large button's height, so the icons sit on Play's centre line.
            minHeight: isCompact ? undefined : PLAY_BUTTON_HEIGHT,
          }}
        >
          {trailerUrl ? (
            <Button
              variant='ghost'
              size='md'
              icon='play'
              onPress={openTrailer}
              accessibilityLabel={t("item.trailer")}
            >
              {t("item.trailer")}
            </Button>
          ) : null}

          {showWatchlist ? (
            <IconAction
              name='watchlist'
              active={inWatchlist}
              activeColor={accent[500]}
              label={
                inWatchlist
                  ? t("item.in_watchlist")
                  : t("item.add_to_watchlist")
              }
              testID='details-watchlist'
              onPress={() => watchlistSheet.current?.open(item)}
            />
          ) : null}

          <IconAction
            name='favorite'
            active={Boolean(isFavorite)}
            activeColor={accent[500]}
            label={
              isFavorite ? t("item.remove_favorite") : t("item.add_favorite")
            }
            testID='details-favorite'
            onPress={toggleFavorite}
          />

          <IconAction
            name='check'
            active={played}
            activeColor={accent[500]}
            label={played ? t("item.mark_unwatched") : t("item.mark_watched")}
            testID='details-watched'
            onPress={() => void togglePlayed(!played)}
          />

          {moreActions.length > 0 ? (
            // A plain View to measure, because `Button` does not forward a ref and the menu opens
            // from here.
            <View ref={moreAnchor} collapsable={false}>
              <IconAction
                name='more'
                label={t("item.more_actions")}
                testID='details-more'
                onPress={() => setMoreOpen(true)}
              />
            </View>
          ) : null}
        </View>
      </View>

      {moreActions.length > 0 ? (
        <MoreMenu
          visible={moreOpen}
          onClose={() => setMoreOpen(false)}
          title={t("item.more_actions")}
          actions={moreActions}
          anchorRef={moreAnchor}
        />
      ) : null}

      {showWatchlist ? <WatchlistSheet ref={watchlistSheet} /> : null}
    </View>
  );
};

/**
 * A ghost button that is only a glyph.
 *
 * The icon is passed as a node rather than through `Button`'s `icon` prop
 * because an "on" state (favourited, watched, listed) has to be the accent, and
 * `icon` always takes the button's own label color.
 */
const IconAction: React.FC<{
  name: IconName;
  label: string;
  testID: string;
  onPress: () => void;
  active?: boolean;
  activeColor?: string;
}> = ({ name, label, testID, onPress, active = false, activeColor }) => (
  <Button
    variant='ghost'
    size='md'
    onPress={onPress}
    testID={testID}
    accessibilityLabel={label}
    accessibilityState={{ selected: active }}
    style={{
      minWidth: tokens.control.minTouchTarget,
      paddingHorizontal: 10,
    }}
    iconLeft={
      <IconGlyph name={name} active={active} activeColor={activeColor} />
    }
  />
);

const IconGlyph: React.FC<{
  name: IconName;
  active: boolean;
  activeColor?: string;
}> = ({ name, active, activeColor }) => (
  <Icon
    name={name}
    size={20}
    color={active ? activeColor : undefined}
    tone={active ? "accent" : "primary"}
  />
);

export type { MoreMenuAction };
