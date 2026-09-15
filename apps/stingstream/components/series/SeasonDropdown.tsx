import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { AnchoredMenu, MenuItem } from "@/components/common/Menu";

type Props = {
  item: BaseItemDto;
  seasons: BaseItemDto[];
  initialSeasonIndex?: number;
  state: SeasonIndexState;
  onSelect: (season: BaseItemDto) => void;
};

type SeasonKeys = {
  id: keyof BaseItemDto;
  title: keyof BaseItemDto;
  index: keyof BaseItemDto;
};

export type SeasonIndexState = {
  [seriesId: string]: number | string | null | undefined;
};

/**
 * Which season the episode list is showing.
 *
 * An `AnchoredMenu`: a dropdown under the button in a browser, and the same `Dialog` bottom sheet it
 * always was on a device. It was a centred card on the web too, until Dan asked for menus rather
 * than modals wherever a list of choices is all there is (2026-09-14).
 */
export const SeasonDropdown: React.FC<Props> = ({
  item,
  seasons,
  initialSeasonIndex,
  state,
  onSelect,
}) => {
  const isTv = Platform.isTV;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);

  const keys = useMemo<SeasonKeys>(
    () =>
      item.Type === "Episode"
        ? {
            id: "ParentId",
            title: "SeasonName",
            index: "ParentIndexNumber",
          }
        : {
            id: "Id",
            title: "Name",
            index: "IndexNumber",
          },
    [item],
  );

  const seasonIndex = useMemo(
    () => state[(item[keys.id] as string) ?? ""],
    [state, item, keys],
  );

  // Always use IndexNumber for Season objects (not keys.index which is for the item)
  const sorted = useMemo(
    () =>
      [...(seasons ?? [])].sort(
        (a, b) => Number(a.IndexNumber) - Number(b.IndexNumber),
      ),
    [seasons],
  );

  const selected = useMemo(
    () =>
      sorted.find(
        (season) => Number(season.IndexNumber) === Number(seasonIndex),
      ),
    [sorted, seasonIndex],
  );

  useEffect(() => {
    if (isTv) return;
    if (seasons && seasons.length > 0 && seasonIndex === undefined) {
      let initialIndex: number | undefined;

      if (initialSeasonIndex !== undefined) {
        // Use the provided initialSeasonIndex if it exists in the seasons
        const seasonExists = seasons.some(
          (season) => season[keys.index] === initialSeasonIndex,
        );
        if (seasonExists) {
          initialIndex = initialSeasonIndex;
        }
      }

      if (initialIndex === undefined) {
        // Fall back to the previous logic if initialIndex is not set
        const season1 = seasons.find((season) => season[keys.index] === 1);
        const season0 = seasons.find((season) => season[keys.index] === 0);
        const firstSeason = season1 || season0 || seasons[0];
        onSelect(firstSeason);
      }

      if (initialIndex !== undefined) {
        const initialSeason = seasons.find(
          (season) => season[keys.index] === initialIndex,
        );
        if (initialSeason) onSelect(initialSeason);
        else throw Error("Initial index could not be found!");
      }
    }
  }, [
    isTv,
    seasons,
    seasonIndex,
    item,
    item[keys.id],
    initialSeasonIndex,
    keys,
    onSelect,
  ]);

  if (isTv) return null;

  const label =
    selected?.Name ??
    (seasonIndex != null
      ? `${t("item_card.season")} ${seasonIndex}`
      : t("item_card.select_season"));

  return (
    <>
      <View
        ref={anchor}
        collapsable={false}
        style={{ alignSelf: "flex-start" }}
      >
        <Button
          variant='secondary'
          size='sm'
          testID='details-season-picker'
          onPress={() => setOpen(true)}
          accessibilityLabel={t("item_card.select_season")}
          iconRight={
            <Icon
              name='chevronDown'
              size={16}
              tone='secondary'
              style={{ marginLeft: 8 }}
            />
          }
        >
          {label}
        </Button>
      </View>

      <AnchoredMenu
        visible={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        title={t("item_card.seasons")}
        align='start'
      >
        {sorted.map((season) => (
          <MenuItem
            key={season.Id ?? String(season.IndexNumber)}
            label={
              season.Name || `${t("item_card.season")} ${season.IndexNumber}`
            }
            selected={Number(season.IndexNumber) === Number(seasonIndex)}
            onPress={() => {
              setOpen(false);
              onSelect(season);
            }}
          />
        ))}
      </AnchoredMenu>
    </>
  );
};
