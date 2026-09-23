import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useSegments } from "expo-router";
import { useAtomValue } from "jotai";
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { PixelRatio, Platform, type View } from "react-native";
import {
  getItemNavigation,
  itemRouter,
} from "@/components/common/TouchableItemRouter";
import useRouter from "@/hooks/useAppRouter";
import { apiAtom } from "@/providers/JellyfinProvider";
import { buildItemCards, type CardData, type CardKind } from "./CardData";
import { ItemCardMenu, type ItemCardMenuContext } from "./ItemCardMenu";

type Options = {
  /** Media items — cards are built here, and presses navigate. */
  items?: BaseItemDto[];
  /** Prebuilt cards, for anything that isn't a `BaseItemDto`. */
  cards?: CardData[];
  kind: CardKind;
  useEpisodePoster?: boolean;
  selectedId?: string | null;
  /**
   * The width the cards will actually render at, so their image requests
   * follow the card's real size — see `buildItemCards`'s own doc.
   */
  cardWidth?: number;
  /** Replaces the default navigation (items mode). */
  onPressItem?: (item: BaseItemDto) => void;
  /** Press handler for `cards` mode. */
  onPressId?: (id: string) => void;
  /** Replaces the card menu on long press (items mode). */
  onLongPressItem?: (item: BaseItemDto) => void;
  /** Long-press handler for `cards` mode. */
  onLongPressId?: (id: string) => void;
  /**
   * The card menu (items mode): a hover "..." on the web and a long press on
   * touch, with the watched toggle, favorite and "View show". Default: off.
   */
  enableActionSheet?: boolean;
  /** Which row the cards sit in, for the rows only that row's menu has. */
  menuContext?: ItemCardMenuContext;
};

/**
 * Everything a container of cards needs besides its layout: the cards
 * themselves, what a press means, and the card menu. Kept apart from `CardRow`
 * so another arrangement of the same cards gets all of it free.
 */
export function useItemCardBehavior({
  items,
  cards: providedCards,
  kind,
  useEpisodePoster = false,
  selectedId,
  cardWidth,
  onPressItem,
  onPressId,
  onLongPressItem,
  onLongPressId,
  enableActionSheet = false,
  menuContext,
}: Options) {
  const api = useAtomValue(apiAtom);
  const router = useRouter();
  const segments = useSegments();
  const [menu, setMenu] = useState<{
    item: BaseItemDto;
    anchor: RefObject<View | null>;
  } | null>(null);
  // A long press on a device has no pointer to open from, and the menu is a
  // bottom sheet there that ignores its anchor.
  const noAnchor = useRef<View>(null);

  const from = (segments as string[])[2] || "(home)";

  const cards = useMemo(
    () =>
      providedCards ??
      buildItemCards(items ?? [], {
        api,
        kind,
        useEpisodePoster,
        selectedId,
        cardWidth,
        pixelRatio: PixelRatio.get(),
      }),
    [providedCards, items, api, kind, useEpisodePoster, selectedId, cardWidth],
  );

  const handlePress = useCallback(
    (id: string) => {
      if (onPressId) {
        onPressId(id);
        return;
      }

      const item = items?.find((i) => i.Id === id);
      if (!item) return;

      if (onPressItem) {
        onPressItem(item);
        return;
      }

      // Music libraries navigate via the explicit string route so the dynamic
      // [libraryId] param survives the nested navigator.
      if ("CollectionType" in item && item.CollectionType === "music") {
        router.push(itemRouter(item, from) as any);
        return;
      }

      router.push(getItemNavigation(item, from) as any);
    },
    [from, items, onPressId, onPressItem, router],
  );

  const openMenu = useCallback(
    (id: string, anchor?: RefObject<View | null>) => {
      const item = items?.find((i) => i.Id === id);
      if (!item) return;
      setMenu({ item, anchor: anchor ?? noAnchor });
    },
    [items],
  );

  const handleLongPress = useCallback(
    (id: string, anchor?: RefObject<View | null>) => {
      if (onLongPressId) {
        onLongPressId(id);
        return;
      }

      const item = items?.find((i) => i.Id === id);
      if (!item) return;

      if (onLongPressItem) {
        onLongPressItem(item);
        return;
      }

      openMenu(id, anchor);
    },
    [items, onLongPressId, onLongPressItem, openMenu],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  // Only media items have a played/favorite state to act on — but a screen
  // that handles the long press itself always gets it.
  const allowLongPress =
    Boolean(onLongPressId) ||
    (Boolean(items) && (Boolean(onLongPressItem) || enableActionSheet));

  // The menu itself, as opposed to a screen's own long press. Never on TV,
  // whose screens pass their own (`useTVItemActionModal`).
  const menuEnabled =
    Boolean(items) &&
    enableActionSheet &&
    !onLongPressId &&
    !onLongPressItem &&
    !Platform.isTV;

  return {
    cards,
    handlePress,
    handleLongPress: allowLongPress ? handleLongPress : undefined,
    /**
     * Opens the card menu from a card's own "..." (`Card`'s `onOpenMenu`).
     * Absent where the cards have no menu, so no "..." is drawn there.
     */
    handleOpenMenu: menuEnabled ? openMenu : undefined,
    /** Mount alongside the cards; renders nothing until the menu is asked for. */
    actionSheet: menu ? (
      <ItemCardMenu
        key={menu.item.Id}
        item={menu.item}
        anchorRef={menu.anchor}
        context={menuContext}
        onClose={closeMenu}
      />
    ) : null,
  };
}
