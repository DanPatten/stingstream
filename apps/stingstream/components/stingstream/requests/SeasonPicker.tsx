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
    <View
      testID='requests-season-picker'
      // The picker lines up with the title above it: Seasons sits over season 1, and Select all
      // over the right-hand edge the row is measured to.
      //
      // This used to carry four pixels of horizontal padding to keep the focus ring off the
      // dialog body's `overflow: hidden auto` edge, which sheared it flat. `webFocusRing` draws
      // the ring inside the control now, so nothing can clip it and the inset can go.
      style={{ marginTop: 4, paddingVertical: 4 }}
    >
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
          marginTop: 8,
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
        // Padding out and the same amount of margin back in: the focus ring is drawn inside the
        // control, and on a bare text action with no padding it would land on the words. The
        // margin puts the text back on the right-hand edge the squares below are aligned to.
        {
          paddingVertical: 4,
          paddingHorizontal: 4,
          marginVertical: -4,
          marginHorizontal: -4,
          borderRadius: radius.xs,
        },
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
 * **Chosen is the accent, solid, because that is what selected means everywhere else in this app**
 * — `FilterChip` fills the same way, and a reader has already learned it here. Two other fills were
 * tried and both failed for the same reason: near-white read as *unselected*, because white is this
 * palette's neutral rather than its selected; and the accent at 18 per cent was a dark tint on a
 * dark sheet, near enough to the unchosen square to be a guess. What keeps it clear of the submit
 * button is shape, not colour: a 36px square is not a labelled button, and Select all is a text
 * action rather than a chip in the row.
 *
 * **Both states carry a visible border.** Unchosen was transparent with `border.subtle`, which is
 * eight per cent white over a near-black sheet — invisible in practice, so the row read as six
 * floating numbers. `border.strong` and 1.5px give the square an edge in both states, which is
 * also what makes the selected one legible as a *change* rather than as the only thing there.
 *
 * No tick: the fill says it, and a glyph crowded into a 36px square beside a digit reads as an
 * icon rather than as a season.
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
          alignItems: "center",
          justifyContent: "center",
          height: SEASON_CHIP,
          minWidth: SEASON_CHIP,
          paddingHorizontal: 6,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: selected
            ? accent[500]
            : hovered && isWeb
              ? color.text.tertiary
              : color.border.strong,
          backgroundColor: selected
            ? accent[500]
            : hovered && isWeb
              ? color.bg["3"]
              : color.bg["2"],
        },
        isWeb
          ? ({
              cursor: "pointer",
              transitionDuration: `${motion.fast}ms`,
              // Selected is an accent fill, and the ring is drawn inside the
              // square, so it takes the label's colour there or disappears.
              ...webFocusRing(
                focused,
                color,
                selected ? accent.onAccent : undefined,
              ),
            } as ViewStyle)
          : null,
      ]}
    >
      <Text
        variant='caption'
        weight='bold'
        tone={selected ? "onAccent" : "secondary"}
      >
        {season}
      </Text>
    </Pressable>
  );
}
