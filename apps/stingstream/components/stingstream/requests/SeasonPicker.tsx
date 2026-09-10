import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { Text } from "@/components/common/Text";
import { REQUEST_SEASON_FALLBACK } from "@/constants/Requests";
import { motion, radius, webFocusRing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { RequestSearchResult } from "@/lib/stingstream/requestsApi";

/**
 * Which seasons to ask for: a Select all action, and one square per season.
 *
 * Three shapes came before it and each made the reader work to say the ordinary thing. Twenty
 * numbered chips, so a nine-season show took nine presses to mean "all of it". Then Sonarr's own
 * Monitor presets, which named a choice ("First season") nobody making a *request* wants. Then an
 * "All seasons" chip sitting in the row with the numbers, which is what this fixes:
 *
 * * **A bulk action is not a choice among the things it acts on.** Styled as a pill beside 1..6 it
 *   read as a seventh season rather than as Select all, so it is a text action in the header now —
 *   Select all, or Clear all once everything is on. A checkbox was the first attempt and sat too
 *   large and too high beside a row of small squares.
 * * **Selected must not look like the submit button, and must not look like an icon.** Everything
 *   was solid accent at once — the chips and the Request button under them — so a full row said
 *   "selected", "disabled" and "this is just what chips look like" equally well. Then a tick
 *   inside a round chip turned a season number into a glyph. The fill does the work now: a chosen
 *   season is the text colour inverted, an unchosen one is transparent with a faint edge, and
 *   solid accent stays with the control that submits. Dan, 2026-09-10: *"cramming a checkmark into
 *   a round circle makes it look like an icon rather than a season number."*
 * * **Rounded squares, not capsules.** 36x36 frames one digit and two equally well; a pill has to
 *   grow sideways for the second and the row stops lining up.
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

/** One season square. Frames a single digit and two the same, which a capsule cannot. */
const SEASON_CHIP = 36;

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
          all={all}
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
 * The bulk action, as a text action rather than a control with a box round it.
 *
 * It says what pressing it does rather than carrying a state of its own, which is why the word
 * changes: Select all while some are off, Clear all once they are all on. A checkbox here read as
 * a fourth kind of control on a small sheet that already has chips, a Cancel and a submit.
 */
function SelectAll({ all, onPress }: { all: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const label = all
    ? t("requests.seasons_clear_all")
    : t("requests.seasons_select_all");

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole='button'
      accessibilityLabel={label}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID='requests-seasons-select-all'
      style={[
        { paddingVertical: 2, paddingHorizontal: 4, borderRadius: radius.xs },
        isWeb
          ? ({ cursor: "pointer", ...webFocusRing(focused) } as ViewStyle)
          : null,
      ]}
    >
      <Text variant='caption' weight='semibold' tone='accent'>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * One season: a 36x36 rounded square with a number in it.
 *
 * Chosen inverts — the text colour becomes the fill and the page colour becomes the number — which
 * is the loudest a control can be without borrowing the accent the submit button owns. Unchosen is
 * transparent with a faint edge, so an untouched row reads as an outline of choices rather than as
 * six disabled buttons. No tick: the fill already says it, and a glyph crowded into a 36px square
 * beside a digit reads as an icon rather than as a season.
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
  const { color } = useTheme();
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
          alignItems: "center",
          justifyContent: "center",
          height: SEASON_CHIP,
          minWidth: SEASON_CHIP,
          paddingHorizontal: 6,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: selected
            ? color.text.primary
            : hovered && isWeb
              ? color.border.strong
              : color.border.subtle,
          backgroundColor: selected
            ? color.text.primary
            : hovered && isWeb
              ? color.bg["2"]
              : "transparent",
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
      <Text
        variant='caption'
        weight='bold'
        tone={selected ? "primary" : "tertiary"}
        // The inverse of the page, so a filled square reads as "on" without spending the accent
        // that belongs to the submit button. `tone` has no name for it: it is the background
        // colour used as ink.
        style={selected ? { color: color.bg["0"] } : undefined}
      >
        {season}
      </Text>
    </Pressable>
  );
}
