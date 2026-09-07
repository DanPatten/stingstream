import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/common/Dialog";
import { Icon } from "@/components/common/Icon";
import { radius, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";
import { Text } from "../common/Text";

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
 * A `Dialog` rather than `PlatformDropdown`: that component routes every
 * non-TV surface through the global `@gorhom/bottom-sheet`, and the sheet does
 * not present on web at all — measured at 390, 600 and 1440 on 2026-09-07, the
 * season picker put no node in the DOM when tapped, at any width. `Dialog` is
 * a centred card in a browser and the same bottom sheet on a phone, so this is
 * one control that works everywhere instead of two that work in one place each.
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

      <Dialog
        visible={open}
        onClose={() => setOpen(false)}
        title={t("item_card.seasons")}
      >
        <View style={{ marginHorizontal: -8 }}>
          {sorted.map((season) => (
            <SeasonRow
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
        </View>
      </Dialog>
    </>
  );
};

const SeasonRow: React.FC<{
  label: string;
  selected: boolean;
  onPress: () => void;
}> = ({ label, selected, onPress }) => {
  const states = usePressableStates({});
  const { accent } = useTheme();

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...states.handlers}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: tokens.control.minTouchTarget,
          paddingHorizontal: 8,
          borderRadius: radius.sm,
          backgroundColor: states.overlay ?? "transparent",
        },
        states.webStyle,
      ]}
    >
      <Text variant='body' weight={selected ? "semibold" : "regular"}>
        {label}
      </Text>
      {selected ? <Icon name='check' size={18} color={accent[500]} /> : null}
    </Pressable>
  );
};
