import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Checkbox } from "@/components/common/Checkbox";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { REQUEST_SEASON_FALLBACK } from "@/constants/Requests";
import { motion, radius, rgba, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { RequestSearchResult } from "@/lib/stingstream/requestsApi";

/**
 * Which seasons to ask for: a Select all checkbox, and one chip per season.
 *
 * Three shapes came before it and each made the reader work to say the ordinary thing. Twenty
 * numbered chips, so a nine-season show took nine presses to mean "all of it". Then Sonarr's own
 * Monitor presets, which named a choice ("First season") nobody making a *request* wants. Then an
 * "All seasons" chip sitting in the row with the numbers, which is what this fixes:
 *
 * * **A bulk action is not a choice among the things it acts on.** Styled as a pill beside 1..6 it
 *   read as a seventh season rather than as Select all, so it is a checkbox above the row now,
 *   which is the shape every list of tickboxes already uses for the same job.
 * * **Selected must not look like the submit button.** Everything was solid accent at once — the
 *   chips, and the Request button under them — so a full row said "selected", "disabled" and "this
 *   is just what chips look like" equally well. Solid accent is reserved for the one control that
 *   submits; a chosen season is a tinted, accent-bordered chip with a tick, and an unchosen one is
 *   charcoal with a quiet border. Dan, 2026-09-10, on the version before this: *"'All seasons' is
 *   styled as a pill button alongside individual season numbers, making it look like an
 *   independent choice rather than a bulk action... It is also visually identical to the primary
 *   Request CTA."*
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

const isWeb = Platform.OS === "web";

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
    <View testID='requests-season-picker' style={{ marginTop: 4 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text variant='caption' weight='semibold' tone='secondary'>
          {t("requests.seasons_label")}
        </Text>
        <SelectAll
          checked={all}
          onPress={() => onChange(all ? [] : allSeasons(total))}
        />
      </View>

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          // Room for the focus ring, which `webFocusRing` draws *outside* the chip: 2px of outline
          // 2px clear of the edge. Without it the first chip's ring is sheared off flat against
          // the dialog's own edge, which reads as a chip that has been cut in half.
          padding: 4,
          marginTop: 6,
        }}
      >
        {allSeasons(total).map((season) => (
          <SeasonChip
            key={season}
            season={season}
            selected={value.includes(season)}
            onPress={() => toggle(season)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * The bulk action, deliberately not a chip.
 *
 * A checkbox and its word, so it reads as "this does something to the row below" rather than as
 * one more thing to choose between. Unticking it clears the selection, which is why the label
 * never changes to "Deselect all": the box's own state already says which way pressing it goes.
 */
function SelectAll({
  checked,
  onPress,
}: {
  checked: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole='checkbox'
      accessibilityState={{ checked }}
      accessibilityLabel={t("requests.seasons_select_all")}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID='requests-seasons-select-all'
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingVertical: 4,
          paddingHorizontal: 4,
          borderRadius: radius.sm,
        },
        isWeb
          ? ({
              cursor: "pointer",
              ...webFocusRing(focused),
            } as ViewStyle)
          : null,
      ]}
    >
      <Checkbox checked={checked} size={18} />
      <Text variant='caption' weight='semibold' tone='secondary'>
        {t("requests.seasons_select_all")}
      </Text>
    </Pressable>
  );
}

/**
 * One season.
 *
 * Outlined rather than filled, so a row of them cannot be mistaken for a row of buttons: the only
 * solid accent in this sheet is the control that submits it. Chosen is the accent at
 * `Pill`'s own soft alpha with the accent's border and a tick; unchosen is the surface one step up
 * from the sheet with a quiet edge.
 */
function SeasonChip({
  season,
  selected,
  onPress,
}: {
  season: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole='checkbox'
      accessibilityState={{ checked: selected }}
      // A row of bare numbers is unreadable to a screen reader, and "3" is not a control name.
      accessibilityLabel={t("requests.season_n", { n: season })}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          minHeight: 36,
          minWidth: 40,
          justifyContent: "center",
          paddingHorizontal: selected ? 10 : 14,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: selected
            ? accent[500]
            : hovered && isWeb
              ? color.border.strong
              : color.border.subtle,
          backgroundColor: selected
            ? rgba(accent[500], 0.16)
            : hovered && isWeb
              ? color.bg["3"]
              : color.bg["2"],
        },
        isWeb
          ? ({
              cursor: "pointer",
              transitionDuration: `${motion.fast}ms`,
              ...webFocusRing(focused),
            } as ViewStyle)
          : null,
      ]}
    >
      {selected ? <Icon name='check' size={13} color={accent[500]} /> : null}
      <Text
        variant='caption'
        weight='semibold'
        tone={selected ? "accent" : "secondary"}
      >
        {season}
      </Text>
    </Pressable>
  );
}
