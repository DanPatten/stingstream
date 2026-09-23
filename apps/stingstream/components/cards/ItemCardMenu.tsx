import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Platform, type View } from "react-native";
import { AnchoredMenu, MenuItem } from "@/components/common/Menu";
import { MENU_SHEET_HANDOFF_MS } from "@/constants/animation";
import useRouter from "@/hooks/useAppRouter";
import { useFavorite } from "@/hooks/useFavorite";
import { useSetWatched } from "@/hooks/useSetWatched";
import { useDownload } from "@/providers/DownloadProvider";
import { useOfflineMode } from "@/providers/OfflineModeProvider";
import {
  canMarkWatched,
  isWatched,
  watchedToggleLabelKey,
} from "@/utils/watched";

/** The row a card sits in, for the menu rows only that row has. */
export type ItemCardMenuContext = "continueWatching" | "nextUp";

interface Props {
  item: BaseItemDto;
  context?: ItemCardMenuContext;
  /** What it opens from: the card's "..." on the web, the card itself after a long press. */
  anchorRef: RefObject<View | null>;
  onClose: () => void;
}

/**
 * The "..." on a card: Plex's poster menu.
 *
 * A dropdown from the card's "..." in a browser and the one bottom sheet on a device, because
 * `AnchoredMenu` already is both. It opens from a hover "..." on the web and a long press on
 * touch. TV keeps its own navigation-based long press (`useTVItemActionModal`), since a menu never
 * renders there.
 *
 * Mounted only while open, keyed by the item, so its hooks are bound to one item at a time.
 */
export const ItemCardMenu: React.FC<Props> = ({ item, anchorRef, onClose }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const setWatched = useSetWatched();
  const { isFavorite, toggleFavorite } = useFavorite(item);
  const isOffline = useOfflineMode();
  const { deleteFile } = useDownload();

  // Web hands over at once; a device waits for the sheet to finish closing (see the constant).
  const run = (action: () => void) => () => {
    onClose();
    if (Platform.OS === "web") action();
    else setTimeout(action, MENU_SHEET_HANDOFF_MS);
  };

  const played = isWatched([item]);
  const seriesId =
    item.Type === "Episode" || item.Type === "Season" ? item.SeriesId : null;

  return (
    <AnchoredMenu
      visible
      onClose={onClose}
      anchorRef={anchorRef}
      title={
        item.Type === "Episode"
          ? (item.SeriesName ?? item.Name ?? undefined)
          : (item.Name ?? undefined)
      }
      minWidth={220}
    >
      {canMarkWatched(item) ? (
        <MenuItem
          icon='check'
          label={t(watchedToggleLabelKey([item]))}
          testID='card-menu-watched'
          onPress={run(() => void setWatched([item], !played))}
        />
      ) : null}
      <MenuItem
        icon='favorite'
        label={isFavorite ? t("item.remove_favorite") : t("item.add_favorite")}
        testID='card-menu-favorite'
        onPress={run(toggleFavorite)}
      />
      {seriesId && !isOffline ? (
        <MenuItem
          icon='tvShows'
          label={t("item_card.view_series")}
          testID='card-menu-show'
          onPress={run(() =>
            router.push({
              pathname: "/series/[id]",
              params: { id: seriesId },
            } as never),
          )}
        />
      ) : null}
      {isOffline && item.Id ? (
        <MenuItem
          icon='delete'
          label={t("home.downloads.delete_download")}
          testID='card-menu-delete-download'
          onPress={run(() => deleteFile(item.Id!))}
        />
      ) : null}
    </AnchoredMenu>
  );
};
