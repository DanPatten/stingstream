import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Button } from "@/components/Button";
import { Pill } from "@/components/common/Pill";
import { Text } from "@/components/common/Text";
import { seasonsLabel } from "@/lib/stingstream/requestsApi";

/**
 * Which seasons of a series to ask for — a row of chips inside `RequestSheet`, not a modal of its
 * own. Nesting a second `Modal`/sheet inside the one `RequestSheet` already is would be two layered
 * overlays on a phone and two centred cards on a desktop; a series request is common enough that
 * its picker belongs in the sheet's own body.
 *
 * Two things about the shape, both learned from what the node does with the answer:
 *
 * * **An empty selection means "all of them", and is the default.** It is not the same as "none":
 *   Sonarr's `addOptions.monitor: all` and a per-season tick list are different mechanisms, and
 *   the request carries an empty list precisely so the node can use the first. Somebody who leaves
 *   every chip untouched and presses Request gets the whole show, which is what they would expect.
 * * **Season 0 is not offered.** It is the specials folder, and "the whole show" to a person does
 *   not include the Christmas special nobody asked for. The node's `ApplySeasons` agrees.
 *
 * The season *count* is not known here — the request is made from a search result, before anything
 * has been added to Sonarr — so the picker offers a generous fixed range and the node ticks only
 * the seasons the series actually has. Asking for season 12 of a nine-season show is harmless:
 * `ApplySeasons` simply never finds it.
 */
export function SeasonPicker({
  value,
  onChange,
  maxSeason = 20,
}: {
  value: number[];
  onChange: (seasons: number[]) => void;
  maxSeason?: number;
}) {
  const { t } = useTranslation();
  const toggle = (season: number) =>
    onChange(
      value.includes(season)
        ? value.filter((s) => s !== season)
        : [...value, season].sort((a, b) => a - b),
    );

  return (
    <View style={{ marginTop: 16 }} testID='requests-season-picker'>
      <Text variant='caption' weight='semibold'>
        {seasonsLabel(value)}
      </Text>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 10,
        }}
      >
        {Array.from({ length: maxSeason }, (_, i) => i + 1).map((season) => {
          const active = value.includes(season);
          return (
            <Pill
              key={season}
              label={String(season)}
              tone={active ? "accent" : "neutral"}
              emphasis={active ? "solid" : "soft"}
              onPress={() => toggle(season)}
              accessibilityLabel={t("requests.season_n", { n: season })}
            />
          );
        })}
      </View>
      {value.length > 0 ? (
        <Button
          variant='ghost'
          size='sm'
          onPress={() => onChange([])}
          style={{ marginTop: 10, alignSelf: "flex-start" }}
        >
          {t("requests.seasons_reset")}
        </Button>
      ) : null}
    </View>
  );
}
