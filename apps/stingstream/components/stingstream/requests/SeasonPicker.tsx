import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { FilterChip } from "@/components/filters/FilterChip";
import { REQUEST_SEASON_FALLBACK } from "@/constants/Requests";
import type { RequestSearchResult } from "@/lib/stingstream/requestsApi";

/**
 * Which seasons to ask for: one row of chips, All seasons first and then every season the show
 * actually has.
 *
 * Two shapes came before it and both made the reader work to say the ordinary thing. First it was
 * twenty numbered chips and nothing else, so asking for a nine-season show meant nine presses to
 * express "all of it". Then it was Sonarr's own Monitor presets, which named a choice ("First
 * season") nobody making a *request* wants and hid the seasons behind a third chip. Dan,
 * 2026-09-10: *"Lets do [All Seasons] [1] [2]... to end. With all seasons being selected by
 * default."*
 *
 * **All seasons is a select-all, and shows its work.** Pressing it fills every numbered chip
 * rather than replacing them with one lit chip, and pressing it again empties them — so the row
 * always says which seasons are going to be asked for, and the shortcut is discoverable without a
 * "Select all / Deselect all" pair of links announcing itself. Dan: *"when all seasons are
 * selected actually SELECT all seasons on the right - its a select all/unselect all without
 * screaming that."*
 *
 * Two things about the value, both from what the node does with the answer:
 *
 * * **Everything ticked is sent as an empty list.** `seasonsForRequest` does that conversion.
 *   Sonarr's `addOptions.monitor: all` and a per-season tick list are different mechanisms, and an
 *   empty list is what lets the node use the first — so "all of it" stays one instruction rather
 *   than an enumeration that happens to cover everything.
 * * **Season 0 is not offered.** It is the specials folder, and "the whole show" to a person does
 *   not include the Christmas special nobody asked for. The node's `ApplySeasons` agrees.
 */

/** How many chips to draw for a show: its real count, or the fallback for a node that did not say. */
export const seasonTotal = (
  result: Pick<RequestSearchResult, "seasonCount"> | null | undefined,
): number =>
  result?.seasonCount && result.seasonCount > 0
    ? result.seasonCount
    : REQUEST_SEASON_FALLBACK;

/** Every season, which is where a fresh sheet starts. */
export const allSeasons = (total: number): number[] =>
  Array.from({ length: total }, (_, i) => i + 1);

/**
 * The list to put on the request.
 *
 * Empty when everything is ticked, because that is how the node is told "the whole show" — see the
 * note above. A caller must not send an empty selection: there is no way to express "none" on the
 * wire, and `[]` would mean the opposite of what was on screen.
 */
export const seasonsForRequest = (value: number[], total: number): number[] =>
  value.length === total ? [] : value;

export function SeasonPicker({
  value,
  onChange,
  total,
}: {
  value: number[];
  onChange: (seasons: number[]) => void;
  /** How many chips to draw. From {@link seasonTotal}. */
  total: number;
}) {
  const { t } = useTranslation();
  const all = value.length === total;

  const toggle = (season: number) =>
    onChange(
      value.includes(season)
        ? value.filter((s) => s !== season)
        : [...value, season].sort((a, b) => a - b),
    );

  return (
    <View
      testID='requests-season-picker'
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        // Room for the focus ring, which `webFocusRing` draws *outside* the chip: 2px of outline
        // 2px clear of the edge. Without it the first chip's ring is sheared off flat against the
        // dialog's own edge, which reads as a chip that has been cut in half.
        padding: 4,
        marginTop: 12,
      }}
    >
      <FilterChip
        label={t("requests.seasons_all")}
        active={all}
        onPress={() => onChange(all ? [] : allSeasons(total))}
      />
      {allSeasons(total).map((season) => (
        <FilterChip
          key={season}
          label={String(season)}
          active={value.includes(season)}
          onPress={() => toggle(season)}
          // A row of bare numbers is unreadable to a screen reader, and "3" is not a control name.
          accessibilityLabel={t("requests.season_n", { n: season })}
        />
      ))}
    </View>
  );
}
