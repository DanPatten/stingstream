/**
 * "Play from…" on phone and web.
 *
 * The mesh has had a complete source-selection data layer since M4 and no screen: the only way to
 * influence which node a title streams from was to change the node's own policy. This is that
 * screen — Auto, every holder, what each one would give you, and one tap to move.
 *
 * Presented through `Dialog` (WP0) rather than `PlatformDropdown`, which the other pickers use:
 * `PlatformDropdown`'s option shape is a label and a radio dot, and a row here has to carry a
 * subtitle and up to three badges, plus a control below the first row. `Dialog` also gets the
 * surface right on its own — a centred card on a desktop browser, the same bottom sheet as
 * everything else on a phone.
 */

import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { type FC, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
import { Dialog } from "@/components/common/Dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { Pill } from "@/components/common/Pill";
import { Tabs } from "@/components/common/Tabs";
import { Text } from "@/components/common/Text";
import { radius, type ThemePalette } from "@/constants/theme";
import {
  type UseSourceSelectionResult,
  useSourceSelection,
} from "@/hooks/useSourceSelection";
import { useTheme } from "@/hooks/useTheme";
import {
  formatSourceChoice,
  type PlaybackPolicy,
  type SourceChoice,
  type SourceChoiceLabels,
} from "@/lib/stingstream/sourceChooser";
import { AUTO_KEY } from "@/lib/stingstream/sourceSelection";
import { useSettings } from "@/utils/atoms/settings";

export interface SourceChooserSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The item whose holders are listed. Must carry `MediaSources`. */
  item?: BaseItemDto | null;
  currentMediaSourceId?: string | null;
  /**
   * A selection the caller has already resolved. The details page and the player both need it for
   * their own controls, so they pass theirs in rather than having the sheet resolve a second one
   * from the same query — two `resolve` calls over one list can only ever agree, but two *pins*
   * held in two `useState`s could drift after a tap.
   */
  selection?: UseSourceSelectionResult;
  /**
   * Where a pick goes when the sheet resolves its own selection — the in-player chooser, whose
   * switch tears down mpv and re-enters the route, so it cannot simply set a piece of state.
   * Ignored when `selection` is passed, because that caller has already wired its own.
   */
  onSelect?: (mediaSourceId: string) => void;
  /**
   * What the badge on the current row says. "Playing" inside the player, "Selected" before
   * anything has started — nothing is playing on a details page, and saying so is a small lie the
   * user notices.
   */
  currentLabel?: string;
}

/** The chooser's own copy of the route colors, so a row's dot matches the player's pill. */
const dotFor = (choice: SourceChoice, palette: ThemePalette): string => {
  if (choice.local) return palette.text.primary;
  if (!choice.online) return palette.text.disabled;
  if (choice.route === "direct") return palette.state.success;
  if (choice.route === "relayed") return palette.state.warning;
  return palette.text.tertiary;
};

export const SourceChooserSheet: FC<SourceChooserSheetProps> = ({
  visible,
  onClose,
  item,
  currentMediaSourceId,
  selection: provided,
  onSelect,
  currentLabel,
}) => {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const [pressed, setPressed] = useState<string | null>(null);

  const fetched = useSourceSelection(item, {
    currentMediaSourceId,
    onSelectMediaSource: onSelect,
    enabled: visible && !provided,
  });
  const selection = provided ?? fetched;
  const isLoading = !provided && fetched.isLoading;

  const labels: SourceChoiceLabels = useMemo(
    () => ({
      ...selection.labels,
      playing: currentLabel ?? selection.labels.playing,
    }),
    [selection.labels, currentLabel],
  );

  // The short spellings, not the settings page's "Fastest source" / "Best quality": a segmented
  // control has room for two words and the same two words are what the television's row says.
  const segments = useMemo(
    () => [
      { key: "speed_first", label: t("player.source.policy_speed") },
      { key: "quality_first", label: t("player.source.policy_quality") },
    ],
    [t],
  );

  const choose = selection.choose;
  const handleSelect = useCallback(
    (key: string) => {
      onClose();
      choose(key);
    },
    [onClose, choose],
  );

  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={t("player.source.play_from")}
    >
      <View testID='player-source-chooser'>
        {isLoading && selection.choices.length === 0 ? (
          <View style={{ paddingVertical: 32, alignItems: "center" }}>
            <ActivityIndicator />
          </View>
        ) : selection.choices.length === 0 ? (
          <EmptyState
            icon='sharing'
            title={t("player.source.none_title")}
            detail={t("player.source.none_description")}
          />
        ) : (
          selection.menu.map((row) =>
            row.choice === null ? (
              <View key={row.key}>
                <AutoRow
                  selected={row.selected}
                  target={selection.autoTarget}
                  pressed={pressed === AUTO_KEY}
                  onPressIn={() => setPressed(AUTO_KEY)}
                  onPressOut={() => setPressed(null)}
                  onPress={() => handleSelect(AUTO_KEY)}
                />
                {/* Under Auto rather than at the top of the sheet, because it is Auto's own
                    setting: it decides what "the best copy" means, and it changes nothing at all
                    while a specific server is pinned. It is still the device-wide setting every
                    future Play honours, which is why it stays visible either way. */}
                <Text
                  variant='caption'
                  tone='tertiary'
                  style={{ marginTop: 4, marginBottom: 6, marginLeft: 12 }}
                >
                  {t("player.source.auto_prefers")}
                </Text>
                <Tabs
                  segments={segments}
                  value={settings.playbackPolicy}
                  onChange={(key) =>
                    updateSettings({ playbackPolicy: key as PlaybackPolicy })
                  }
                  contentInset={0}
                  style={{ marginBottom: 12 }}
                />
              </View>
            ) : (
              <View key={row.key}>
                <SourceRow
                  choice={row.choice}
                  labels={labels}
                  selected={row.selected}
                  pressed={pressed === row.key}
                  onPressIn={() => setPressed(row.key)}
                  onPressOut={() => setPressed(null)}
                  onPress={() => handleSelect(row.key)}
                />
                {row.selected ? (
                  <Text
                    variant='caption'
                    tone='secondary'
                    style={{ marginTop: -2, marginBottom: 8, marginLeft: 12 }}
                  >
                    {t("player.source.pinned_note")}
                  </Text>
                ) : null}
              </View>
            ),
          )
        )}
      </View>
    </Dialog>
  );
};

/** Auto: the row that means "decide for me", and says what that comes to right now. */
const AutoRow: FC<{
  selected: boolean;
  target: string | null;
  pressed: boolean;
  onPress: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
}> = ({ selected, target, pressed, onPress, onPressIn, onPressOut }) => {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const subtitle = target
    ? t("player.source.auto_now", { source: target })
    : t("player.source.auto_nothing");

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole='button'
      accessibilityState={{ selected }}
      accessibilityLabel={`${t("player.source.auto")}, ${subtitle}`}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: radius.md,
          marginBottom: 6,
          backgroundColor: pressed ? color.bg["3"] : color.bg["2"],
          borderWidth: 1,
          borderColor: selected ? accent[500] : "transparent",
        },
        Platform.OS === "web" ? ({ cursor: "pointer" } as never) : null,
      ]}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: radius.pill,
          backgroundColor: target ? color.state.success : color.text.tertiary,
          marginRight: 12,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {t("player.source.auto")}
        </Text>
        <Text variant='caption' tone='secondary' numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      {selected ? (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: radius.pill,
            backgroundColor: accent[500],
            marginLeft: 8,
          }}
        />
      ) : null}
    </Pressable>
  );
};

const SourceRow: FC<{
  choice: SourceChoice;
  labels: SourceChoiceLabels;
  selected: boolean;
  pressed: boolean;
  onPress: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
}> = ({
  choice,
  labels,
  selected,
  pressed,
  onPress,
  onPressIn,
  onPressOut,
}) => {
  const { color, accent } = useTheme();
  const { title, subtitle, badges } = formatSourceChoice(choice, labels);

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={choice.disabled}
      accessibilityRole='button'
      accessibilityState={{ disabled: choice.disabled, selected }}
      accessibilityLabel={[title, subtitle, ...badges]
        .filter(Boolean)
        .join(", ")}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          paddingVertical: 12,
          paddingHorizontal: 12,
          borderRadius: radius.md,
          marginBottom: 6,
          backgroundColor: pressed ? color.bg["3"] : color.bg["2"],
          borderWidth: 1,
          borderColor: selected ? accent[500] : "transparent",
          opacity: choice.disabled ? 0.5 : 1,
        },
        Platform.OS === "web" && !choice.disabled
          ? ({ cursor: "pointer" } as never)
          : null,
      ]}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: radius.pill,
          backgroundColor: dotFor(choice, color),
          marginRight: 12,
        }}
      />
      <View style={{ flex: 1 }}>
        <Text variant='body' weight='semibold' numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant='caption' tone='secondary' numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {badges.length ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            {badges.map((badge) => (
              <Pill
                key={badge}
                label={badge}
                size='sm'
                tone={
                  badge === labels.recommended
                    ? "accent"
                    : badge === labels.offline
                      ? "danger"
                      : "neutral"
                }
                style={{ marginRight: 6 }}
              />
            ))}
          </View>
        ) : null}
      </View>
      {selected ? (
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: radius.pill,
            backgroundColor: accent[500],
            marginLeft: 8,
          }}
        />
      ) : null}
    </Pressable>
  );
};
